import "server-only";
import { createHash } from "node:crypto";
import { looksLikeInstructionsForAi } from "@/lib/chatbot/engine/guardrails";
import { enqueueIngest } from "@/lib/chatbot/jobs";
import { ProviderError, type EmbeddingProvider } from "@/lib/chatbot/providers/types";
import { getEmbeddingProvider } from "@/lib/chatbot/providers/registry";
import { recordUsage } from "@/lib/chatbot/usage/meter";
import { log } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { chunkFaq, chunkText, MAX_CHUNKS_PER_DOCUMENT, type Chunk } from "./chunk";
import { ExtractionError, extractContent } from "./extract";
import { normalizeText } from "./normalize";
import { downloadObject } from "./storage";

/**
 * Ingesta de una versión de documento (04 §15.1, 15.5): extraer → normalizar → fragmentar → embeber → activar.
 * Idempotente: reprocesar no duplica fragmentos, y una versión que falla deja respondiendo a la anterior.
 */

export type IngestOutcome =
  | { outcome: "ready"; reason?: "unchanged" }
  | { outcome: "failed"; reason: string }
  | { outcome: "continued" }
  | { outcome: "skipped"; reason: string };

export interface IngestOptions {
  embeddings?: EmbeddingProvider;
  /** Instante (ms epoch) a partir del cual se corta la tanda y se re-encola. Por defecto, 40 s desde ahora. */
  deadline?: number;
  /** Corta tras N tandas de embeddings (para probar la continuación). */
  maxBatches?: number;
}

const BATCH = 64;
const BUDGET_MS = 40_000;
const STALE_MS = 5 * 60_000;
const MAX_EXTRACTED_CHARS = 500_000;

interface DocRow {
  id: string;
  source_id: string;
  business_id: string;
  version: number;
  mime_type: string | null;
  extracted_text: string | null;
}
interface SourceRow {
  id: string;
  business_id: string;
  type: "faq" | "text" | "file" | "url";
  title: string;
  faq_question: string | null;
  faq_answer: string | null;
  body: string | null;
  url: string | null;
  storage_path: string | null;
  status: string;
  active_document_id: string | null;
  deleted_at: string | null;
}

const db = () => getSupabaseAdmin();
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Toma la versión para procesarla: nueva, o una tanda anterior liberada o abandonada (> 5 min). */
async function claim(documentId: string): Promise<DocRow | null> {
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const { data, error } = await db()
    .from("knowledge_documents")
    .update({ status: "processing", processing_started_at: new Date().toISOString(), error: null })
    .eq("id", documentId)
    .or(`status.eq.pending,and(status.eq.processing,processing_started_at.is.null),and(status.eq.processing,processing_started_at.lt.${stale})`)
    .select("id, source_id, business_id, version, mime_type, extracted_text")
    .maybeSingle<DocRow>();
  if (error) throw error;
  return data;
}

async function release(documentId: string, status: "pending" | "processing") {
  await db().from("knowledge_documents").update({ status, processing_started_at: null }).eq("id", documentId);
}

/** Error permanente: la versión queda `failed`; la fuente sigue con su versión activa si la tiene. */
async function fail(doc: DocRow, source: SourceRow, message: string): Promise<IngestOutcome> {
  await db().from("knowledge_documents").update({ status: "failed", error: { message }, processing_started_at: null }).eq("id", doc.id);
  const failure = { message, document_id: doc.id, version: doc.version };
  const update = source.active_document_id || source.status === "disabled" ? { last_error: failure } : { status: "failed", last_error: failure };
  await db().from("knowledge_sources").update(update).eq("id", source.id);
  log.warn("knowledge.ingest", "ingesta fallida", { documentId: doc.id, sourceId: source.id, reason: message });
  return { outcome: "failed", reason: message };
}

async function loadContent(source: SourceRow, doc: DocRow): Promise<{ text: string; checksum: string }> {
  switch (source.type) {
    case "faq": {
      const text = `Pregunta: ${source.faq_question}\nRespuesta: ${source.faq_answer}`;
      return { text, checksum: sha256(text) };
    }
    case "text": {
      const text = normalizeText(source.body ?? "");
      if (!text) throw new ExtractionError("El texto está vacío");
      return { text, checksum: sha256(text) };
    }
    case "url": {
      const { text } = await extractContent({ kind: "url", url: source.url! });
      return { text, checksum: sha256(text) };
    }
    case "file": {
      if (!source.storage_path) throw new ExtractionError("La fuente no tiene archivo");
      const bytes = await downloadObject(source.business_id, source.storage_path);
      const { text } = await extractContent({ kind: "file", bytes, mimeType: doc.mime_type ?? "" });
      return { text, checksum: sha256(bytes) };
    }
  }
}

export async function ingestDocument(documentId: string, options: IngestOptions = {}): Promise<IngestOutcome> {
  const embeddings = options.embeddings ?? getEmbeddingProvider();
  const deadline = options.deadline ?? Date.now() + BUDGET_MS;

  const doc = await claim(documentId);
  if (!doc) return { outcome: "skipped", reason: "La versión no está pendiente (ya procesada o en curso)" };

  const { data: source, error: sourceError } = await db()
    .from("knowledge_sources")
    .select("id, business_id, type, title, faq_question, faq_answer, body, url, storage_path, status, active_document_id, deleted_at")
    .eq("id", doc.source_id)
    .maybeSingle<SourceRow>();
  if (sourceError) {
    await release(doc.id, "pending");
    throw sourceError;
  }
  if (!source || source.deleted_at) {
    await db().from("knowledge_documents").update({ status: "failed", error: { message: "La fuente fue eliminada" }, processing_started_at: null }).eq("id", doc.id);
    return { outcome: "skipped", reason: "La fuente fue eliminada" };
  }
  if (source.status === "disabled") {
    await release(doc.id, "pending"); // se procesará al reactivar la fuente
    return { outcome: "skipped", reason: "La fuente está desactivada" };
  }

  try {
    // Una versión más antigua que la activa no puede reemplazarla.
    if (source.active_document_id) {
      const { data: active } = await db().from("knowledge_documents").select("version, checksum_sha256").eq("id", source.active_document_id).maybeSingle();
      if (active && active.version > doc.version) return await fail(doc, source, "Reemplazada por una versión más reciente");
    }

    let text = doc.extracted_text;
    if (text === null) {
      // Primera tanda: extraer y guardar. Se parte de cero (idempotencia: sin fragmentos previos de esta versión).
      await db().from("knowledge_chunks").delete().eq("document_id", doc.id);
      const content = await loadContent(source, doc);
      if (content.text.length > MAX_EXTRACTED_CHARS) throw new ExtractionError("Documento demasiado largo");
      text = content.text;
      await db()
        .from("knowledge_documents")
        .update({
          extracted_text: text,
          extracted_chars: text.length,
          checksum_sha256: content.checksum,
          embedding_model: embeddings.model,
          embedding_dimensions: embeddings.dimensions,
        })
        .eq("id", doc.id);

      // Mismo contenido que la versión activa: no se vuelve a embeber.
      if (source.active_document_id && source.active_document_id !== doc.id) {
        const { data: active } = await db().from("knowledge_documents").select("checksum_sha256").eq("id", source.active_document_id).maybeSingle();
        if (active?.checksum_sha256 === content.checksum) {
          await db().from("knowledge_documents").update({ status: "ready", processed_at: new Date().toISOString(), processing_started_at: null }).eq("id", doc.id);
          await db().from("knowledge_sources").update({ last_error: null, last_processed_at: new Date().toISOString() }).eq("id", source.id);
          return { outcome: "ready", reason: "unchanged" };
        }
      }
    }

    const chunks: Chunk[] = source.type === "faq" ? chunkFaq(source.faq_question ?? "", source.faq_answer ?? "", source.title) : chunkText(text, source.title);
    if (chunks.length === 0) throw new ExtractionError("No se encontró texto para procesar");
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) throw new ExtractionError("Documento demasiado largo");

    const { data: done, error: doneError } = await db().from("knowledge_chunks").select("chunk_index").eq("document_id", doc.id);
    if (doneError) throw doneError;
    const have = new Set((done ?? []).map((r) => r.chunk_index as number));
    const pending = chunks.filter((c) => !have.has(c.index));

    let batches = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
      if (Date.now() >= deadline || (options.maxBatches !== undefined && batches >= options.maxBatches)) {
        // Se acabó el tiempo de esta ejecución: se libera la versión y se vuelve a encolar para continuar.
        await release(doc.id, "processing");
        await enqueueIngest(doc.id, have.size + i);
        return { outcome: "continued" };
      }
      batches++;
      const batch = pending.slice(i, i + BATCH);
      const started = Date.now();
      const { vectors, tokens } = await embeddings.embed(batch.map((c) => c.content), "document");
      const { error } = await db().from("knowledge_chunks").insert(
        batch.map((c, n) => ({
          business_id: doc.business_id,
          source_id: doc.source_id,
          document_id: doc.id,
          chunk_index: c.index,
          content: c.content,
          token_estimate: c.tokenEstimate,
          metadata: { ...(c.section ? { section: c.section } : {}), ...(looksLikeInstructionsForAi(c.text) ? { suspicious: true } : {}) },
          embedding: `[${vectors[n].join(",")}]`,
        })),
      );
      if (error) throw error;
      await recordUsage({
        businessId: doc.business_id,
        operation: "embedding_ingest",
        provider: embeddings.name,
        model: embeddings.model,
        usage: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0 },
        latencyMs: Date.now() - started,
      });
    }

    const { error: activateError } = await db().rpc("activate_knowledge_document", { p_document_id: doc.id });
    if (activateError) throw activateError;
    return { outcome: "ready" };
  } catch (error) {
    if (error instanceof ExtractionError) return fail(doc, source, error.message);
    if (error instanceof ProviderError && !error.retryable) return fail(doc, source, error.message);
    await release(doc.id, "pending"); // transitorio: QStash reintentará
    throw error;
  }
}
