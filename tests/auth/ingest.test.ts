/** Ingesta y recuperación de conocimiento contra la base real, con embeddings falsos (T-05.5 y T-05.6). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Member } from "@/lib/auth/session";
import { FakeEmbeddingProvider } from "@/lib/chatbot/providers/fake";
import { ProviderError } from "@/lib/chatbot/providers/types";
import { ingestDocument } from "@/lib/chatbot/rag/ingest";
import { MAX_CHUNKS_PER_SOURCE, retrieveChunks } from "@/lib/chatbot/rag/retrieve";
import { createSource, getSource, newVersion, setEnabled, softDelete } from "@/lib/chatbot/rag/sources";
import { BUCKET, createUploadTarget } from "@/lib/chatbot/rag/storage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { qstashFake } from "../fakes/qstash";
import { makePdf } from "../helpers/fixtures";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();

describe.skipIf(!hasDb)("ingesta y recuperación", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  let adminA: Member;
  const objects: string[] = [];
  const emb = () => new FakeEmbeddingProvider();

  async function member(biz: TestBusiness): Promise<Member> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `admin-${biz.id.slice(0, 4)}-${RUN_ID}@example.test`, display_name: "admin", role: "admin", status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role: "admin", displayName: "admin", legacy: false };
  }
  const faq = (title: string, question: string, answer: string) => ({ type: "faq" as const, title, question, answer });
  const lastDoc = async (sourceId: string) => {
    const v = (await getSource((await srcBiz(sourceId)), sourceId)).versions;
    return v[0];
  };
  const srcBiz = async (sourceId: string) => (await db().from("knowledge_sources").select("business_id").eq("id", sourceId).single()).data!.business_id as string;
  const chunkCount = async (sourceId: string) => (await db().from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("source_id", sourceId)).count!;
  const sourceRow = async (sourceId: string) => (await db().from("knowledge_sources").select("status, active_document_id, chunk_count, last_error").eq("id", sourceId).single()).data!;

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    adminA = await member(a);
  }, 60_000);
  afterAll(async () => {
    if (objects.length) await db().storage.from(BUCKET).remove(objects);
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);

  describe("ingestDocument", () => {
    it("FAQ: queda ready con un fragmento, versión activa y uso registrado", async () => {
      const s = await createSource(a.id, faq("Horario", "¿A qué hora abren?", "De 9 a 18"), adminA);
      const doc = await lastDoc(s.id);
      const e = emb();
      expect(await ingestDocument(doc.id, { embeddings: e })).toEqual({ outcome: "ready" });

      expect(await sourceRow(s.id)).toMatchObject({ status: "ready", active_document_id: doc.id, chunk_count: 1, last_error: null });
      const { data: d } = await db().from("knowledge_documents").select("status, extracted_chars, checksum_sha256, embedding_model, embedding_dimensions").eq("id", doc.id).single();
      expect(d).toMatchObject({ status: "ready", embedding_model: "fake-embedding", embedding_dimensions: 1024, checksum_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(e.calls).toHaveLength(1);
      expect(e.calls[0].kind).toBe("document");
      expect(e.calls[0].texts[0]).toContain("Pregunta: ¿A qué hora abren?");
      const { data: usage } = await db().from("chatbot_usage").select("operation, provider, model, input_tokens").eq("business_id", a.id).eq("operation", "embedding_ingest");
      expect(usage!.length).toBeGreaterThanOrEqual(1);
      expect(usage![0]).toMatchObject({ provider: "fake", model: "fake-embedding" });
    });

    it("reprocesar la misma versión no duplica fragmentos", async () => {
      const s = await createSource(a.id, { type: "text", title: "Largo", body: Array.from({ length: 30 }, (_, i) => `Párrafo ${i}. ${"relleno de texto ".repeat(40)}`).join("\n\n") }, adminA);
      const doc = await lastDoc(s.id);
      await ingestDocument(doc.id, { embeddings: emb() });
      const n = await chunkCount(s.id);
      expect(n).toBeGreaterThan(5);

      expect(await ingestDocument(doc.id, { embeddings: emb() })).toMatchObject({ outcome: "skipped" }); // ya ready
      await db().from("knowledge_documents").update({ status: "pending", extracted_text: null }).eq("id", doc.id); // simula un reproceso forzado
      await ingestDocument(doc.id, { embeddings: emb() });
      expect(await chunkCount(s.id)).toBe(n);
      const { data } = await db().from("knowledge_chunks").select("chunk_index").eq("source_id", s.id).order("chunk_index");
      expect(data!.map((r) => r.chunk_index)).toEqual(Array.from({ length: n }, (_, i) => i));
    });

    it("una versión nueva reemplaza a la anterior y purga sus fragmentos; el mismo contenido no re-embebe", async () => {
      const s = await createSource(a.id, faq("Precios", "¿Cuánto cuesta un corte?", "400 pesos"), adminA);
      const v1 = await lastDoc(s.id);
      await ingestDocument(v1.id, { embeddings: emb() });

      const v2 = await newVersion(s.id, a.id, adminA, { answer: "450 pesos" });
      const e = emb();
      await ingestDocument(v2.id, { embeddings: e });
      expect((await sourceRow(s.id)).active_document_id).toBe(v2.id);
      expect(await chunkCount(s.id)).toBe(1);
      const { data } = await db().from("knowledge_chunks").select("document_id, content").eq("source_id", s.id);
      expect(data).toHaveLength(1);
      expect(data![0]).toMatchObject({ document_id: v2.id, content: expect.stringContaining("450 pesos") });

      const v3 = await newVersion(s.id, a.id, adminA); // sin cambios de contenido
      const e3 = emb();
      expect(await ingestDocument(v3.id, { embeddings: e3 })).toEqual({ outcome: "ready", reason: "unchanged" });
      expect(e3.calls).toHaveLength(0);
      expect((await sourceRow(s.id)).active_document_id).toBe(v2.id); // la activa no cambia
      expect((await lastDoc(s.id)).status).toBe("ready");
    });

    it("un fallo permanente deja la versión anterior respondiendo", async () => {
      const s = await createSource(a.id, { type: "url", title: "Web", url: "https://example.com/x" }, adminA);
      // Primera versión sin versión activa: la fuente pasa a failed con un error legible.
      await db().from("knowledge_sources").update({ url: "https://127.0.0.1/admin" }).eq("id", s.id);
      const r1 = await ingestDocument((await lastDoc(s.id)).id, { embeddings: emb() });
      expect(r1).toMatchObject({ outcome: "failed", reason: expect.stringContaining("red privada") });
      expect(await sourceRow(s.id)).toMatchObject({ status: "failed", active_document_id: null, last_error: { message: expect.stringContaining("red privada") } });

      // Con versión activa: la fuente sigue ready y solo guarda el error.
      const f = await createSource(a.id, faq("Estable", "¿Hay estacionamiento?", "Sí, gratuito"), adminA);
      await ingestDocument((await lastDoc(f.id)).id, { embeddings: emb() });
      const active = (await sourceRow(f.id)).active_document_id;
      await db().from("knowledge_sources").update({ type: "url", url: "https://10.0.0.1/", faq_question: null, faq_answer: null }).eq("id", f.id);
      const v2 = await newVersion(f.id, a.id, adminA);
      expect(await ingestDocument(v2.id, { embeddings: emb() })).toMatchObject({ outcome: "failed" });
      expect(await sourceRow(f.id)).toMatchObject({ status: "ready", active_document_id: active, last_error: { message: expect.stringContaining("red privada") } });
      expect(await chunkCount(f.id)).toBe(1);
    });

    it("un fallo transitorio del proveedor relanza el error, deja la versión pending y el reintento no duplica", async () => {
      const s = await createSource(a.id, { type: "text", title: "Transitorio", body: "Texto con información suficiente para generar un fragmento de prueba." }, adminA);
      const doc = await lastDoc(s.id);
      const flaky = emb();
      flaky.failWith = new ProviderError("límite", true, 429);
      await expect(ingestDocument(doc.id, { embeddings: flaky })).rejects.toMatchObject({ retryable: true });
      expect((await lastDoc(s.id)).status).toBe("pending");
      expect(await ingestDocument(doc.id, { embeddings: emb() })).toEqual({ outcome: "ready" });
      expect(await chunkCount(s.id)).toBe(1);
    });

    it("un error no reintentable del proveedor es permanente", async () => {
      const s = await createSource(a.id, faq("Clave mala", "¿x?", "y"), adminA);
      const bad = emb();
      bad.failWith = new ProviderError("La clave de Voyage no es válida", false, 401);
      expect(await ingestDocument((await lastDoc(s.id)).id, { embeddings: bad })).toMatchObject({ outcome: "failed", reason: expect.stringContaining("clave") });
      expect((await sourceRow(s.id)).status).toBe("failed");
    });

    it("si se acaba el tiempo, procesa por tandas: 'continued', se re-encola y al continuar no duplica", async () => {
      const body = Array.from({ length: 200 }, (_, i) => `## Sección ${i}\n${"contenido de relleno ".repeat(20)}`).join("\n\n");
      const bytes = new TextEncoder().encode(body);
      const t = await createUploadTarget(a.id, { name: "enorme.txt", mimeType: "text/plain", sizeBytes: bytes.byteLength });
      const { error } = await db().storage.from(BUCKET).uploadToSignedUrl(t.path, t.token, bytes as never, { contentType: "text/plain" });
      if (error) throw error;
      objects.push(t.path);
      const s = await createSource(a.id, { type: "file", title: "Enorme", storagePath: t.path, mimeType: "text/plain", sizeBytes: bytes.byteLength }, adminA);
      const doc = await lastDoc(s.id);
      qstashFake.reset();

      const first = await ingestDocument(doc.id, { embeddings: emb(), maxBatches: 1 });
      expect(first).toEqual({ outcome: "continued" });
      expect(await chunkCount(s.id)).toBe(64);
      expect((await sourceRow(s.id)).active_document_id).toBeNull(); // todavía no responde con esta versión
      expect(qstashFake.jobs.filter((j) => j.path === "/api/jobs/knowledge-ingest")).toHaveLength(1);

      const e = emb();
      expect(await ingestDocument(doc.id, { embeddings: e })).toEqual({ outcome: "ready" });
      expect(e.calls.flatMap((c) => c.texts).length + 64).toBe(await chunkCount(s.id)); // solo embebió lo que faltaba
      const { data } = await db().from("knowledge_chunks").select("chunk_index").eq("source_id", s.id).order("chunk_index");
      expect(data!.length).toBeGreaterThan(64);
      expect(data!.map((r) => r.chunk_index)).toEqual(Array.from({ length: data!.length }, (_, i) => i));
      expect((await sourceRow(s.id)).active_document_id).toBe(doc.id);
    });

    it("fuente eliminada o desactivada: se omite; al reactivar se encola", async () => {
      const s = await createSource(a.id, faq("Se apaga", "¿p?", "q"), adminA);
      const doc = await lastDoc(s.id);
      await setEnabled(a.id, s.id, false, adminA);
      expect(await ingestDocument(doc.id, { embeddings: emb() })).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("desactivada") });
      expect((await lastDoc(s.id)).status).toBe("pending");

      qstashFake.reset();
      await setEnabled(a.id, s.id, true, adminA);
      expect(qstashFake.jobs).toHaveLength(1);
      expect(await ingestDocument(doc.id, { embeddings: emb() })).toEqual({ outcome: "ready" });

      const d = await createSource(a.id, faq("Se borra", "¿r?", "s"), adminA);
      const dDoc = await lastDoc(d.id);
      await softDelete(a.id, d.id, adminA);
      expect(await ingestDocument(dDoc.id, { embeddings: emb() })).toMatchObject({ outcome: "skipped", reason: expect.stringContaining("eliminada") });
      expect(await chunkCount(d.id)).toBe(0);
    });

    it("una versión más vieja que la activa no la reemplaza", async () => {
      const s = await createSource(a.id, faq("Orden", "¿t?", "u"), adminA);
      const v1 = await lastDoc(s.id);
      const v2 = await newVersion(s.id, a.id, adminA, { answer: "nueva" });
      await ingestDocument(v2.id, { embeddings: emb() });
      expect(await ingestDocument(v1.id, { embeddings: emb() })).toMatchObject({ outcome: "failed", reason: expect.stringContaining("más reciente") });
      expect((await sourceRow(s.id)).active_document_id).toBe(v2.id);
    });

    it("archivos: un TXT y un PDF subidos a Storage quedan ready", async () => {
      for (const [name, mime, bytes] of [
        ["lista.txt", "text/plain", new TextEncoder().encode("Lista de precios\n\nCorte de pelo: 400 pesos\nBarba: 250 pesos")],
        ["catalogo.pdf", "application/pdf", makePdf(["Catalogo de servicios: corte de pelo, barba, coloracion y tratamientos capilares para todos."])],
      ] as const) {
        const t = await createUploadTarget(a.id, { name, mimeType: mime, sizeBytes: bytes.byteLength });
        const { error } = await db().storage.from(BUCKET).uploadToSignedUrl(t.path, t.token, bytes as never, { contentType: mime });
        if (error) throw error;
        objects.push(t.path);
        const s = await createSource(a.id, { type: "file", title: name, storagePath: t.path, mimeType: mime, sizeBytes: bytes.byteLength }, adminA);
        expect(await ingestDocument((await lastDoc(s.id)).id, { embeddings: emb() }), name).toEqual({ outcome: "ready" });
        expect((await sourceRow(s.id)).chunk_count, name).toBeGreaterThanOrEqual(1);
      }
    });

    it("un PDF escaneado falla con un mensaje legible", async () => {
      const bytes = makePdf(["", ""]);
      const t = await createUploadTarget(a.id, { name: "scan.pdf", mimeType: "application/pdf", sizeBytes: bytes.byteLength });
      await db().storage.from(BUCKET).uploadToSignedUrl(t.path, t.token, bytes as never, { contentType: "application/pdf" });
      objects.push(t.path);
      const s = await createSource(a.id, { type: "file", title: "scan", storagePath: t.path, mimeType: "application/pdf", sizeBytes: bytes.byteLength }, adminA);
      expect(await ingestDocument((await lastDoc(s.id)).id, { embeddings: emb() })).toMatchObject({ outcome: "failed", reason: expect.stringContaining("escaneado") });
      expect((await sourceRow(s.id)).last_error).toMatchObject({ message: expect.stringContaining("OCR") });
    });
  });

  describe("retrieveChunks", () => {
    let ba: TestBusiness;
    let bb: TestBusiness;
    let ma: Member;
    let mb: Member;
    const ingest = async (biz: TestBusiness, m: Member, input: Parameters<typeof createSource>[1]) => {
      const s = await createSource(biz.id, input, m);
      await ingestDocument((await lastDoc(s.id)).id, { embeddings: emb() });
      return s;
    };

    beforeAll(async () => {
      ba = await createTestBusiness();
      bb = await createTestBusiness();
      ma = await member(ba);
      mb = await member(bb);
      await ingest(ba, ma, faq("Horarios", "¿Cuál es el horario de atención?", "Atendemos de lunes a viernes de 9 a 18 horas"));
      await ingest(ba, ma, faq("Pagos", "¿Qué formas de pago aceptan?", "Aceptamos efectivo y tarjetas de crédito"));
      await ingest(ba, ma, faq("Ubicación", "¿Dónde están ubicados?", "Estamos en la calle Mercedes 1234 esquina Rio Negro"));
      await ingest(bb, mb, faq("Horarios", "¿Cuál es el horario de atención?", "Atendemos solamente los sábados por la mañana"));
    }, 120_000);
    afterAll(async () => {
      await cleanup(ba?.id);
      await cleanup(bb?.id);
    });

    it("encuentra el fragmento correcto de la pregunta, con ids cortos c1…", async () => {
      const r = await retrieveChunks(ba.id, "¿A qué hora es el horario de atención?", { embeddings: emb() });
      expect(r.length).toBeGreaterThan(0);
      expect(r[0]).toMatchObject({ ref: "c1", title: "Horarios", content: expect.stringContaining("lunes a viernes") });
      expect(r.map((x) => x.ref)).toEqual(r.map((_, i) => `c${i + 1}`));
      const pagos = await retrieveChunks(ba.id, "pagos con tarjeta de crédito", { embeddings: emb() });
      expect(pagos[0].title).toBe("Pagos");
    });

    it("aislamiento: cada negocio recupera solo lo suyo (S-04)", async () => {
      const ra = await retrieveChunks(ba.id, "horario de atención", { embeddings: emb() });
      const rb = await retrieveChunks(bb.id, "horario de atención", { embeddings: emb() });
      expect(ra[0].content).toContain("lunes a viernes");
      expect(rb[0].content).toContain("sábados");
      expect(rb.every((x) => !x.content.includes("lunes a viernes") && !x.content.includes("Mercedes"))).toBe(true);
      expect(ra.every((x) => !x.content.includes("sábados"))).toBe(true);
    });

    it("sin coincidencias o consulta vacía → lista vacía", async () => {
      expect(await retrieveChunks(ba.id, "   ", { embeddings: emb() })).toEqual([]);
      expect(await retrieveChunks(ba.id, "zzzz qqqq xxxx", { embeddings: emb(), minSimilarity: 0.9 })).toEqual([]);
    });

    it("fuentes desactivadas o eliminadas dejan de aparecer", async () => {
      const s = await ingest(ba, ma, faq("Temporal", "¿Hay promoción de verano?", "Promoción de verano con descuento del veinte por ciento"));
      expect((await retrieveChunks(ba.id, "promoción de verano", { embeddings: emb() }))[0].title).toBe("Temporal");
      await setEnabled(ba.id, s.id, false, ma);
      expect((await retrieveChunks(ba.id, "promoción de verano", { embeddings: emb() })).some((x) => x.title === "Temporal")).toBe(false);
      await setEnabled(ba.id, s.id, true, ma);
      expect((await retrieveChunks(ba.id, "promoción de verano", { embeddings: emb() }))[0].title).toBe("Temporal");
      await softDelete(ba.id, s.id, ma);
      expect((await retrieveChunks(ba.id, "promoción de verano", { embeddings: emb() })).some((x) => x.title === "Temporal")).toBe(false);
    });

    it("máximo 3 fragmentos por fuente", async () => {
      const body = Array.from({ length: 12 }, (_, i) => `## Tema ${i}\nLa garantía cubre defectos de fabricación durante el período número ${i}. ${"garantía ".repeat(150)}`).join("\n\n");
      await ingest(ba, ma, { type: "text", title: "Garantía", body });
      const r = await retrieveChunks(ba.id, "garantía defectos de fabricación", { embeddings: emb() });
      expect(r.filter((x) => x.title === "Garantía").length).toBeLessThanOrEqual(MAX_CHUNKS_PER_SOURCE);
      expect(r.filter((x) => x.title === "Garantía").length).toBe(MAX_CHUNKS_PER_SOURCE);
    });

    it("registra el uso de la consulta (embedding_query) y usa kind 'query'", async () => {
      const e = emb();
      await retrieveChunks(ba.id, "horario", { embeddings: e });
      expect(e.calls.at(-1)).toMatchObject({ kind: "query", texts: ["horario"] });
      const { data } = await db().from("chatbot_usage").select("operation").eq("business_id", ba.id).eq("operation", "embedding_query");
      expect(data!.length).toBeGreaterThan(0);
    });
  });
});
