import "server-only";
import { auditIpHash } from "@/lib/security/ip";
import { z } from "zod";
import { ServiceError } from "@/lib/appointments/service";
import { can } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { getChatbotLimits } from "@/lib/chatbot/config";
import { enqueueIngest } from "@/lib/chatbot/jobs";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Fuentes de conocimiento y sus versiones (T-05.1). Todas las funciones reciben `businessId` y filtran por él.
 * Una versión nueva (`knowledge_documents`) nace `pending`; la fuente sigue respondiendo con la versión activa
 * anterior hasta que el job de ingesta la active (`activate_knowledge_document`, T-05.5).
 */

export const CATEGORIES = ["products_services", "policies", "hours", "contact", "faq", "other"] as const;
export const SOURCE_TYPES = ["faq", "text", "file", "url"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export type KnowledgeStatus = "pending" | "processing" | "ready" | "failed" | "disabled";
const MAX_FILE_BYTES = 10 * 1024 * 1024; // tope duro de la base (check de knowledge_documents)

const title = z.string().trim().min(1, "El título no puede estar vacío").max(200, "El título admite hasta 200 caracteres");
const category = z.enum(CATEGORIES, { error: "Categoría inválida" });
const question = z.string().trim().min(1, "La pregunta no puede estar vacía").max(500, "La pregunta admite hasta 500 caracteres");
const answer = z.string().trim().min(1, "La respuesta no puede estar vacía").max(4000, "La respuesta admite hasta 4000 caracteres");
const body = z.string().trim().min(1, "El texto no puede estar vacío").max(50000, "El texto admite hasta 50000 caracteres");
const url = z
  .string()
  .trim()
  .max(2000, "La dirección es demasiado larga")
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "La dirección debe empezar con https:// y no puede incluir usuario ni contraseña");

const fileInfo = z.object({
  storagePath: z.string().min(1, "Falta el archivo"),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int("Tamaño inválido").positive("El archivo está vacío"),
});

export type SourceInput =
  | { type: "faq"; title: string; category?: (typeof CATEGORIES)[number]; question: string; answer: string }
  | { type: "text"; title: string; category?: (typeof CATEGORIES)[number]; body: string }
  | { type: "url"; title: string; category?: (typeof CATEGORIES)[number]; url: string }
  | ({ type: "file"; title: string; category?: (typeof CATEGORIES)[number] } & z.input<typeof fileInfo>);

/** Contenido de una versión nueva: depende del tipo de la fuente. */
export type VersionContent = Partial<{ question: string; answer: string; body: string; url: string }> &
  Partial<z.input<typeof fileInfo>>;

export interface Source {
  id: string;
  businessId: string;
  type: SourceType;
  category: (typeof CATEGORIES)[number];
  title: string;
  faqQuestion: string | null;
  faqAnswer: string | null;
  body: string | null;
  url: string | null;
  storagePath: string | null;
  status: KnowledgeStatus;
  activeDocumentId: string | null;
  lastError: unknown;
  chunkCount: number;
  lastProcessedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface DocumentVersion {
  id: string;
  sourceId: string;
  version: number;
  status: KnowledgeStatus;
  mimeType: string | null;
  sizeBytes: number | null;
  error: unknown;
  createdAt: string;
  processedAt: string | null;
}

interface SourceRow {
  id: string;
  business_id: string;
  type: SourceType;
  category: (typeof CATEGORIES)[number];
  title: string;
  faq_question: string | null;
  faq_answer: string | null;
  body: string | null;
  url: string | null;
  storage_path: string | null;
  status: KnowledgeStatus;
  active_document_id: string | null;
  last_error: unknown;
  chunk_count: number;
  last_processed_at: string | null;
  updated_at: string;
  created_at: string;
}

const SOURCE_COLUMNS =
  "id, business_id, type, category, title, faq_question, faq_answer, body, url, storage_path, status, active_document_id, last_error, chunk_count, last_processed_at, updated_at, created_at";
const DOC_COLUMNS = "id, source_id, version, status, mime_type, size_bytes, error, created_at, processed_at";

const db = () => getSupabaseAdmin();

function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    businessId: r.business_id,
    type: r.type,
    category: r.category,
    title: r.title,
    faqQuestion: r.faq_question,
    faqAnswer: r.faq_answer,
    body: r.body,
    url: r.url,
    storagePath: r.storage_path,
    status: r.status,
    activeDocumentId: r.active_document_id,
    lastError: r.last_error,
    chunkCount: r.chunk_count,
    lastProcessedAt: r.last_processed_at,
    updatedAt: r.updated_at,
    createdAt: r.created_at,
  };
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ServiceError(issue.code === "unrecognized_keys" ? `Campo desconocido: ${issue.keys.join(", ")}` : issue.message);
  }
  return r.data;
}

function assertCanWrite(member: Member) {
  if (!can(member.role, "knowledge.write")) throw new ServiceError("No tienes permiso para editar la base de conocimiento", 403);
}

async function audit(member: Member, businessId: string, action: string, sourceId: string, diff?: Record<string, unknown>) {
  const { error } = await db().from("audit_log").insert({
    business_id: businessId,
    actor_member_id: member.id,
    action,
    target_type: "knowledge_source",
    target_id: sourceId,
    diff: diff ?? null,
    ip_hash: await auditIpHash(),
  });
  if (error) throw error;
}

async function loadRow(businessId: string, id: string): Promise<SourceRow> {
  const { data, error } = await db()
    .from("knowledge_sources")
    .select(SOURCE_COLUMNS)
    .eq("id", id)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .maybeSingle<SourceRow>();
  if (error) throw error;
  if (!data) throw new ServiceError("La fuente no existe", 404);
  return data;
}

function assertOwnFile(businessId: string, storagePath: string) {
  if (!storagePath.startsWith(`${businessId}/`) || storagePath.includes("..")) {
    throw new ServiceError("El archivo no pertenece a este negocio");
  }
}

function assertFileSize(sizeBytes: number) {
  const limit = Math.min(getChatbotLimits().knowledgeMaxFileMb * 1024 * 1024, MAX_FILE_BYTES);
  if (sizeBytes > limit) throw new ServiceError(`El archivo supera el máximo de ${Math.floor(limit / 1024 / 1024)} MB`);
}

/** Encola el procesamiento; si QStash falla, la versión queda `failed` con un error que el panel muestra y permite reintentar. */
async function enqueueOrFail(sourceId: string, documentId: string) {
  try {
    await enqueueIngest(documentId);
  } catch (error) {
    console.error("[knowledge] no se pudo encolar la ingesta", error instanceof Error ? error.message : "error");
    const failure = { message: "No se pudo iniciar el procesamiento. Intenta de nuevo." };
    await db().from("knowledge_documents").update({ status: "failed", error: failure }).eq("id", documentId);
    // Con una versión activa, la fuente sigue respondiendo con ella: solo se anota el error.
    const { data: src } = await db().from("knowledge_sources").select("active_document_id").eq("id", sourceId).single();
    await db()
      .from("knowledge_sources")
      .update(src?.active_document_id ? { last_error: failure } : { status: "failed", last_error: failure })
      .eq("id", sourceId);
  }
}

/** Crea una versión `pending` de la fuente con el contenido actual de la fuente y la encola. */
async function insertVersion(
  businessId: string,
  source: SourceRow,
  member: Member,
  file?: { mimeType: string; sizeBytes: number },
): Promise<DocumentVersion> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: last, error: lastError } = await db()
      .from("knowledge_documents")
      .select("version")
      .eq("source_id", source.id)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;

    const { data, error } = await db()
      .from("knowledge_documents")
      .insert({
        source_id: source.id,
        business_id: businessId,
        version: (last?.version ?? 0) + 1,
        status: "pending",
        mime_type: file?.mimeType ?? null,
        size_bytes: file?.sizeBytes ?? null,
        created_by: member.id,
      })
      .select(DOC_COLUMNS)
      .single();
    if (error?.code === "23505") continue; // otra versión nació a la vez: se recalcula el número
    if (error) throw error;
    return toVersion(data);
  }
  throw new ServiceError("No se pudo crear la versión, intenta de nuevo", 409);
}

function toVersion(r: Record<string, unknown>): DocumentVersion {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    version: r.version as number,
    status: r.status as KnowledgeStatus,
    mimeType: (r.mime_type as string | null) ?? null,
    sizeBytes: (r.size_bytes as number | null) ?? null,
    error: r.error ?? null,
    createdAt: r.created_at as string,
    processedAt: (r.processed_at as string | null) ?? null,
  };
}

/** Límites de ingesta por negocio (07 §19.10): 50 fuentes por día y 200 MB de archivos por mes. */
export const MAX_SOURCES_PER_DAY = 50;
export const MAX_UPLOAD_BYTES_PER_MONTH = 200 * 1024 * 1024;

async function assertIngestQuota(businessId: string, input: SourceInput) {
  const now = new Date();
  const { count, error } = await db()
    .from("knowledge_sources")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("created_at", new Date(now.getTime() - 24 * 3_600_000).toISOString()); // incluye las eliminadas: borrar no libera el cupo
  if (error) throw error;
  if ((count ?? 0) >= MAX_SOURCES_PER_DAY) {
    throw new ServiceError(`Alcanzaste el máximo de ${MAX_SOURCES_PER_DAY} fuentes por día. Intenta de nuevo mañana.`);
  }
  if (input?.type !== "file") return;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error: sizeError } = await db().from("knowledge_documents").select("size_bytes").eq("business_id", businessId).gte("created_at", monthStart).not("size_bytes", "is", null);
  if (sizeError) throw sizeError;
  const used = (data ?? []).reduce((sum, d) => sum + ((d.size_bytes as number) ?? 0), 0);
  if (used + (Number(input.sizeBytes) || 0) > MAX_UPLOAD_BYTES_PER_MONTH) {
    throw new ServiceError("Alcanzaste el máximo de 200 MB de archivos por mes.");
  }
}

export async function createSource(businessId: string, input: SourceInput, member: Member): Promise<Source> {
  assertCanWrite(member);
  await assertIngestQuota(businessId, input);
  const base = { business_id: businessId, created_by: member.id, updated_by: member.id, status: "pending" as const };
  let row: Record<string, unknown>;
  let file: { mimeType: string; sizeBytes: number } | undefined;

  switch (input?.type) {
    case "faq": {
      const v = parse(z.object({ title, category: category.default("faq"), question, answer }), input);
      row = { ...base, type: "faq", title: v.title, category: v.category, faq_question: v.question, faq_answer: v.answer };
      break;
    }
    case "text": {
      const v = parse(z.object({ title, category: category.default("other"), body }), input);
      row = { ...base, type: "text", title: v.title, category: v.category, body: v.body };
      break;
    }
    case "url": {
      const v = parse(z.object({ title, category: category.default("other"), url }), input);
      row = { ...base, type: "url", title: v.title, category: v.category, url: v.url };
      break;
    }
    case "file": {
      const v = parse(z.object({ title, category: category.default("other") }).and(fileInfo), input);
      assertOwnFile(businessId, v.storagePath);
      assertFileSize(v.sizeBytes);
      row = { ...base, type: "file", title: v.title, category: v.category, storage_path: v.storagePath };
      file = { mimeType: v.mimeType, sizeBytes: v.sizeBytes };
      break;
    }
    default:
      throw new ServiceError("Tipo de fuente inválido");
  }

  const { data, error } = await db().from("knowledge_sources").insert(row).select(SOURCE_COLUMNS).single<SourceRow>();
  if (error) throw error;

  const version = await insertVersion(businessId, data, member, file);
  await audit(member, businessId, "knowledge.created", data.id, { type: data.type, title: data.title });
  await enqueueOrFail(data.id, version.id);
  return toSource(await loadRow(businessId, data.id));
}

/**
 * Nueva versión de una fuente: actualiza el contenido de la fuente y crea un documento `pending`.
 * No toca `active_document_id`: la versión anterior sigue respondiendo hasta que la nueva quede `ready`.
 */
export async function newVersion(
  sourceId: string,
  businessId: string,
  member: Member,
  content: VersionContent = {},
): Promise<DocumentVersion> {
  assertCanWrite(member);
  const source = await loadRow(businessId, sourceId);
  const update: Record<string, unknown> = { updated_by: member.id };
  let file: { mimeType: string; sizeBytes: number } | undefined;

  switch (source.type) {
    case "faq": {
      const v = parse(z.object({ question: question.optional(), answer: answer.optional() }).strict(), pick(content, ["question", "answer"]));
      if (v.question !== undefined) update.faq_question = v.question;
      if (v.answer !== undefined) update.faq_answer = v.answer;
      break;
    }
    case "text": {
      const v = parse(z.object({ body: body.optional() }).strict(), pick(content, ["body"]));
      if (v.body !== undefined) update.body = v.body;
      break;
    }
    case "url": {
      const v = parse(z.object({ url: url.optional() }).strict(), pick(content, ["url"]));
      if (v.url !== undefined) update.url = v.url;
      break;
    }
    case "file": {
      // Reprocesar el mismo archivo (sin datos nuevos) es válido; uno nuevo exige los tres datos.
      if (content.storagePath !== undefined || content.mimeType !== undefined || content.sizeBytes !== undefined) {
        const v = parse(fileInfo, content);
        assertOwnFile(businessId, v.storagePath);
        assertFileSize(v.sizeBytes);
        update.storage_path = v.storagePath;
        file = { mimeType: v.mimeType, sizeBytes: v.sizeBytes };
      } else {
        const { data: prev } = await db()
          .from("knowledge_documents")
          .select("mime_type, size_bytes")
          .eq("source_id", sourceId)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (prev?.mime_type && prev.size_bytes) file = { mimeType: prev.mime_type, sizeBytes: prev.size_bytes };
      }
      break;
    }
  }

  // Sin versión activa la fuente no responde: pasa a `pending` y limpia el error anterior.
  if (!source.active_document_id) Object.assign(update, { status: "pending", last_error: null });
  const { error } = await db().from("knowledge_sources").update(update).eq("id", sourceId).eq("business_id", businessId);
  if (error) throw error;

  const version = await insertVersion(businessId, source, member, file);
  await enqueueOrFail(sourceId, version.id);
  return version;
}

function pick(content: VersionContent, keys: (keyof VersionContent)[]): Record<string, unknown> {
  const extra = Object.keys(content).filter((k) => !keys.includes(k as keyof VersionContent) && (content as Record<string, unknown>)[k] !== undefined);
  if (extra.length > 0) throw new ServiceError(`Campo no válido para este tipo de fuente: ${extra.join(", ")}`);
  return Object.fromEntries(keys.filter((k) => content[k] !== undefined).map((k) => [k, content[k]]));
}

export interface SourcePatch extends VersionContent {
  title?: string;
  category?: (typeof CATEGORIES)[number];
}

/** Título y categoría se guardan sin versión; si cambia el contenido, se crea una versión nueva. */
export async function updateSource(businessId: string, id: string, patch: SourcePatch, member: Member): Promise<Source> {
  assertCanWrite(member);
  const source = await loadRow(businessId, id);
  const { title: newTitle, category: newCategory, ...content } = patch;

  const meta = parse(z.object({ title: title.optional(), category: category.optional() }), { title: newTitle, category: newCategory });
  const diff: Record<string, unknown> = {};
  const update: Record<string, unknown> = {};
  if (meta.title !== undefined && meta.title !== source.title) {
    update.title = meta.title;
    diff.title = { from: source.title, to: meta.title };
  }
  if (meta.category !== undefined && meta.category !== source.category) {
    update.category = meta.category;
    diff.category = { from: source.category, to: meta.category };
  }

  const current: Record<string, unknown> = {
    question: source.faq_question,
    answer: source.faq_answer,
    body: source.body,
    url: source.url,
  };
  const changedContent = Object.fromEntries(
    Object.entries(content).filter(([k, v]) => v !== undefined && (source.type === "file" || current[k] !== (typeof v === "string" ? v.trim() : v))),
  ) as VersionContent;

  if (Object.keys(update).length > 0) {
    const { error } = await db().from("knowledge_sources").update({ ...update, updated_by: member.id }).eq("id", id).eq("business_id", businessId);
    if (error) throw error;
  }
  if (Object.keys(changedContent).length > 0) {
    await newVersion(id, businessId, member, changedContent);
    diff.content = Object.keys(changedContent);
  }
  if (Object.keys(diff).length > 0) await audit(member, businessId, "knowledge.updated", id, diff);
  return toSource(await loadRow(businessId, id));
}

/** Desactivar saca la fuente de las respuestas; reactivar la devuelve si tiene versión activa. */
export async function setEnabled(businessId: string, id: string, enabled: boolean, member: Member): Promise<Source> {
  assertCanWrite(member);
  const source = await loadRow(businessId, id);
  const status: KnowledgeStatus = !enabled ? "disabled" : source.active_document_id ? "ready" : "pending";
  if (status !== source.status) {
    const { error } = await db()
      .from("knowledge_sources")
      .update({ status, updated_by: member.id })
      .eq("id", id)
      .eq("business_id", businessId);
    if (error) throw error;
    await audit(member, businessId, enabled ? "knowledge.enabled" : "knowledge.disabled", id);

    // Una versión que quedó esperando mientras la fuente estaba desactivada se procesa ahora.
    if (enabled && !source.active_document_id) {
      const { data: waiting } = await db()
        .from("knowledge_documents")
        .select("id")
        .eq("source_id", id)
        .eq("status", "pending")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (waiting) await enqueueOrFail(id, waiting.id);
    }
  }
  return toSource(await loadRow(businessId, id));
}

/** Borrado lógico: quita los fragmentos (deja de responder ya) y marca `deleted_at`. La purga física llega a los 30 días. */
export async function softDelete(businessId: string, id: string, member: Member): Promise<void> {
  assertCanWrite(member);
  const source = await loadRow(businessId, id);
  const { error: chunksError } = await db().from("knowledge_chunks").delete().eq("source_id", id).eq("business_id", businessId);
  if (chunksError) throw chunksError;
  const { error } = await db()
    .from("knowledge_sources")
    .update({ deleted_at: new Date().toISOString(), chunk_count: 0, updated_by: member.id })
    .eq("id", id)
    .eq("business_id", businessId);
  if (error) throw error;
  await audit(member, businessId, "knowledge.deleted", id, { type: source.type, title: source.title });
}

export interface SourceFilters {
  type?: SourceType;
  category?: (typeof CATEGORIES)[number];
  status?: KnowledgeStatus;
  /** Búsqueda por título (sin distinguir mayúsculas). */
  q?: string;
}

export async function listSources(businessId: string, filters: SourceFilters = {}): Promise<Source[]> {
  let query = db()
    .from("knowledge_sources")
    .select(SOURCE_COLUMNS)
    .eq("business_id", businessId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.status) query = query.eq("status", filters.status);
  const q = filters.q?.trim().replace(/[%_\\,()]/g, " ");
  if (q) query = query.ilike("title", `%${q}%`);
  const { data, error } = await query.returns<SourceRow[]>();
  if (error) throw error;
  return (data ?? []).map(toSource);
}

export interface SourceContent {
  /** Texto extraído de la versión activa (recortado a 20 000 caracteres para mostrarlo). */
  extractedText: string | null;
  extractedChars: number | null;
  chunks: { index: number; content: string; tokenEstimate: number }[];
}

/** Texto extraído y fragmentos de la versión activa, para el detalle del panel. */
export async function getSourceContent(businessId: string, id: string): Promise<SourceContent> {
  const { source } = await getSource(businessId, id);
  if (!source.activeDocumentId) return { extractedText: null, extractedChars: null, chunks: [] };
  const [{ data: doc, error: docError }, { data: chunks, error: chunksError }] = await Promise.all([
    db().from("knowledge_documents").select("extracted_text, extracted_chars").eq("id", source.activeDocumentId).eq("business_id", businessId).maybeSingle(),
    db().from("knowledge_chunks").select("chunk_index, content, token_estimate").eq("document_id", source.activeDocumentId).eq("business_id", businessId).order("chunk_index"),
  ]);
  if (docError) throw docError;
  if (chunksError) throw chunksError;
  return {
    extractedText: doc?.extracted_text ? doc.extracted_text.slice(0, 20_000) : null,
    extractedChars: doc?.extracted_chars ?? null,
    chunks: (chunks ?? []).map((c) => ({ index: c.chunk_index, content: c.content, tokenEstimate: c.token_estimate })),
  };
}

/** Fragmentos de una fuente marcados como sospechosos al ingerir (instrucciones dirigidas a una IA). */
export async function countSuspiciousChunks(businessId: string, sourceId: string): Promise<number> {
  const { count, error } = await db()
    .from("knowledge_chunks")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("source_id", sourceId)
    .contains("metadata", { suspicious: true });
  if (error) throw error;
  return count ?? 0;
}

export async function getSource(businessId: string, id: string): Promise<{ source: Source; versions: DocumentVersion[] }> {
  const source = toSource(await loadRow(businessId, id));
  const { data, error } = await db()
    .from("knowledge_documents")
    .select(DOC_COLUMNS)
    .eq("source_id", id)
    .eq("business_id", businessId)
    .order("version", { ascending: false });
  if (error) throw error;
  return { source, versions: (data ?? []).map(toVersion) };
}
