/** Servicio de fuentes y versiones de conocimiento contra la base real (T-05.1). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Member } from "@/lib/auth/session";
import {
  createSource,
  getSource,
  listSources,
  newVersion,
  setEnabled,
  softDelete,
  updateSource,
} from "@/lib/chatbot/rag/sources";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { qstashFake } from "../fakes/qstash";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();

describe.skipIf(!hasDb)("fuentes de conocimiento", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  let adminA: Member;
  let operatorA: Member;
  let adminB: Member;

  async function member(biz: TestBusiness, role: Member["role"]): Promise<Member> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `${role}-${biz.id.slice(0, 4)}-${RUN_ID}@example.test`, display_name: role, role, status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role, displayName: role, legacy: false };
  }
  const faq = (n = "Horario") => ({ type: "faq" as const, title: n, question: "¿A qué hora abren?", answer: "De 9 a 18" });
  const docs = async (sourceId: string) =>
    (await db().from("knowledge_documents").select("version, status, mime_type, size_bytes").eq("source_id", sourceId).order("version")).data!;
  /** Simula lo que hará el job de ingesta: un fragmento + activar versión. */
  async function fakeActivate(sourceId: string, businessId: string, documentId: string) {
    const embedding = `[${Array.from({ length: 1024 }, () => 0.01).join(",")}]`;
    const { count } = await db().from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("document_id", documentId);
    if (!count) {
      const { error } = await db().from("knowledge_chunks").insert({
        business_id: businessId, source_id: sourceId, document_id: documentId, chunk_index: 0, content: "x", token_estimate: 1, embedding,
      });
      if (error) throw error;
    }
    const { error } = await db().rpc("activate_knowledge_document", { p_document_id: documentId });
    if (error) throw error;
  }

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    adminA = await member(a, "admin");
    operatorA = await member(a, "operator");
    adminB = await member(b, "admin");
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);

  describe("createSource", () => {
    it("FAQ: crea fuente pending + versión 1 pending y encola la ingesta", async () => {
      qstashFake.reset();
      const s = await createSource(a.id, faq(), adminA);
      expect(s).toMatchObject({ type: "faq", category: "faq", status: "pending", activeDocumentId: null, faqQuestion: "¿A qué hora abren?" });
      expect(await docs(s.id)).toEqual([{ version: 1, status: "pending", mime_type: null, size_bytes: null }]);
      const { data: doc } = await db().from("knowledge_documents").select("id").eq("source_id", s.id).single();
      expect(qstashFake.jobs).toEqual([
        { path: "/api/jobs/knowledge-ingest", body: { documentId: doc!.id }, options: { deduplicationId: `ingest-${doc!.id}-0`, retries: 3 } },
      ]);
      const { data: logs } = await db().from("audit_log").select("action").eq("target_id", s.id);
      expect(logs).toEqual([{ action: "knowledge.created" }]);
    });

    it("texto y URL", async () => {
      const t = await createSource(a.id, { type: "text", title: "Política", category: "policies", body: "No hay devoluciones" }, adminA);
      expect(t).toMatchObject({ type: "text", category: "policies", body: "No hay devoluciones" });
      const u = await createSource(a.id, { type: "url", title: "Web", url: "https://example.com/faq" }, adminA);
      expect(u).toMatchObject({ type: "url", url: "https://example.com/faq", category: "other" });
    });

    it("archivo: exige la ruta con prefijo del negocio y respeta el tamaño máximo", async () => {
      const ok = { type: "file" as const, title: "Lista", storagePath: `${a.id}/abc/lista.pdf`, mimeType: "application/pdf", sizeBytes: 1000 };
      const s = await createSource(a.id, ok, adminA);
      expect(s).toMatchObject({ type: "file", storagePath: `${a.id}/abc/lista.pdf` });
      expect(await docs(s.id)).toEqual([{ version: 1, status: "pending", mime_type: "application/pdf", size_bytes: 1000 }]);

      await expect(createSource(a.id, { ...ok, storagePath: `${b.id}/x/lista.pdf` }, adminA)).rejects.toMatchObject({ message: expect.stringContaining("no pertenece") });
      await expect(createSource(a.id, { ...ok, storagePath: `${a.id}/../${b.id}/x.pdf` }, adminA)).rejects.toMatchObject({ message: expect.stringContaining("no pertenece") });
      await expect(createSource(a.id, { ...ok, sizeBytes: 11 * 1024 * 1024 }, adminA)).rejects.toMatchObject({ message: expect.stringContaining("10 MB") });
    });

    it.each([
      [{ type: "faq", title: "", question: "q", answer: "a" }, "título"],
      [{ type: "faq", title: "T", question: "q", answer: "" }, "respuesta"],
      [{ type: "text", title: "T", body: "   " }, "texto"],
      [{ type: "url", title: "T", url: "http://example.com" }, "https://"],
      [{ type: "url", title: "T", url: "https://user:pw@example.com" }, "https://"],
      [{ type: "url", title: "T", url: "no es url" }, "https://"],
      [{ type: "faq", title: "T", category: "otra", question: "q", answer: "a" }, "Categoría"],
      [{ type: "video", title: "T" }, "Tipo"],
    ])("rechaza %j", async (input, fragment) => {
      await expect(createSource(a.id, input as never, adminA)).rejects.toMatchObject({ status: 400, message: expect.stringContaining(fragment) });
    });

    it("un operador no puede crear (403)", async () => {
      await expect(createSource(a.id, faq(), operatorA)).rejects.toMatchObject({ status: 403 });
    });

    it("si no se puede encolar, la versión queda failed con un error legible y se puede reintentar", async () => {
      qstashFake.publishError = new Error("qstash caído");
      const s = await createSource(a.id, faq("Sin cola"), adminA);
      expect(s).toMatchObject({ status: "failed", lastError: { message: expect.stringContaining("No se pudo iniciar") } });
      expect((await docs(s.id))[0].status).toBe("failed");

      qstashFake.publishError = null;
      await newVersion(s.id, a.id, adminA);
      const after = (await getSource(a.id, s.id)).source;
      expect(after).toMatchObject({ status: "pending", lastError: null });
      expect((await docs(s.id)).map((d) => d.status)).toEqual(["failed", "pending"]);
    });
  });

  describe("versiones", () => {
    it("una versión nueva no altera la activa hasta quedar ready; version = max + 1", async () => {
      const s = await createSource(a.id, faq("Versionada"), adminA);
      const v1 = (await getSource(a.id, s.id)).versions[0];
      await fakeActivate(s.id, a.id, v1.id);
      const active = (await getSource(a.id, s.id)).source;
      expect(active).toMatchObject({ status: "ready", activeDocumentId: v1.id, chunkCount: 1 });

      const v2 = await newVersion(s.id, a.id, adminA, { answer: "De 8 a 20" });
      expect(v2).toMatchObject({ version: 2, status: "pending" });
      const during = (await getSource(a.id, s.id)).source;
      expect(during).toMatchObject({ status: "ready", activeDocumentId: v1.id, faqAnswer: "De 8 a 20" });
      // El fragmento de la v1 sigue ahí respondiendo.
      const { count } = await db().from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("source_id", s.id);
      expect(count).toBe(1);

      await fakeActivate(s.id, a.id, v2.id);
      expect((await getSource(a.id, s.id)).source.activeDocumentId).toBe(v2.id);
      expect((await getSource(a.id, s.id)).versions.map((v) => v.version)).toEqual([2, 1]);
    });

    it("versiones simultáneas obtienen números distintos", async () => {
      const s = await createSource(a.id, faq("Carrera"), adminA);
      const results = await Promise.all([1, 2, 3].map((n) => newVersion(s.id, a.id, adminA, { answer: `r${n}` })));
      const numbers = results.map((r) => r.version).sort();
      expect(new Set(numbers).size).toBe(3);
      expect((await docs(s.id)).map((d) => d.version)).toEqual([1, 2, 3, 4]);
    });

    it("el contenido debe corresponder al tipo de la fuente", async () => {
      const s = await createSource(a.id, faq("Tipo"), adminA);
      await expect(newVersion(s.id, a.id, adminA, { body: "x" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("body") });
      await expect(newVersion(s.id, a.id, adminA, { answer: "" })).rejects.toMatchObject({ status: 400 });
    });

    it("archivo: nueva versión con otro archivo o reprocesando el mismo", async () => {
      const s = await createSource(a.id, { type: "file", title: "Doc", storagePath: `${a.id}/1/doc.pdf`, mimeType: "application/pdf", sizeBytes: 500 }, adminA);
      await newVersion(s.id, a.id, adminA); // mismo archivo
      await newVersion(s.id, a.id, adminA, { storagePath: `${a.id}/2/doc2.pdf`, mimeType: "application/pdf", sizeBytes: 900 });
      expect(await docs(s.id)).toEqual([
        { version: 1, status: "pending", mime_type: "application/pdf", size_bytes: 500 },
        { version: 2, status: "pending", mime_type: "application/pdf", size_bytes: 500 },
        { version: 3, status: "pending", mime_type: "application/pdf", size_bytes: 900 },
      ]);
      expect((await getSource(a.id, s.id)).source.storagePath).toBe(`${a.id}/2/doc2.pdf`);
      await expect(newVersion(s.id, a.id, adminA, { storagePath: `${b.id}/x.pdf`, mimeType: "application/pdf", sizeBytes: 1 })).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("updateSource", () => {
    it("título y categoría no crean versión; el contenido sí; lo igual no hace nada", async () => {
      const s = await createSource(a.id, faq("Editable"), adminA);
      qstashFake.reset();

      await updateSource(a.id, s.id, { title: "Nuevo título", category: "hours" }, adminA);
      expect(await docs(s.id)).toHaveLength(1);
      expect(qstashFake.jobs).toHaveLength(0);

      await updateSource(a.id, s.id, { answer: "De 9 a 18" }, adminA); // igual que antes
      expect(await docs(s.id)).toHaveLength(1);

      const updated = await updateSource(a.id, s.id, { answer: "De 10 a 20" }, adminA);
      expect(updated).toMatchObject({ title: "Nuevo título", category: "hours", faqAnswer: "De 10 a 20" });
      expect(await docs(s.id)).toHaveLength(2);
      expect(qstashFake.jobs).toHaveLength(1);

      const { data: logs } = await db().from("audit_log").select("action, diff").eq("target_id", s.id).eq("action", "knowledge.updated").order("id");
      expect(logs!.map((l) => l.diff)).toEqual([
        { title: { from: "Editable", to: "Nuevo título" }, category: { from: "faq", to: "hours" } },
        { content: ["answer"] },
      ]);
    });
    it("un operador no puede editar (403)", async () => {
      const s = await createSource(a.id, faq("Protegida"), adminA);
      await expect(updateSource(a.id, s.id, { title: "X" }, operatorA)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("setEnabled y softDelete", () => {
    it("desactivar quita la fuente de las respuestas; reactivar la devuelve (ready si tiene versión activa)", async () => {
      const s = await createSource(a.id, faq("Activable"), adminA);
      expect((await setEnabled(a.id, s.id, false, adminA)).status).toBe("disabled");
      expect((await setEnabled(a.id, s.id, true, adminA)).status).toBe("pending"); // nunca se procesó

      const v1 = (await getSource(a.id, s.id)).versions[0];
      await fakeActivate(s.id, a.id, v1.id);
      expect((await setEnabled(a.id, s.id, false, adminA)).status).toBe("disabled");
      expect((await setEnabled(a.id, s.id, true, adminA)).status).toBe("ready");
      const { data: logs } = await db().from("audit_log").select("action").eq("target_id", s.id).like("action", "knowledge.%abled").order("id");
      expect(logs!.map((l) => l.action)).toEqual(["knowledge.disabled", "knowledge.enabled", "knowledge.disabled", "knowledge.enabled"]);
    });

    it("eliminar borra los fragmentos, oculta la fuente y audita; no se puede volver a tocar", async () => {
      const s = await createSource(a.id, faq("Borrable"), adminA);
      await fakeActivate(s.id, a.id, (await getSource(a.id, s.id)).versions[0].id);
      await softDelete(a.id, s.id, adminA);

      const { count } = await db().from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("source_id", s.id);
      expect(count).toBe(0);
      const { data: row } = await db().from("knowledge_sources").select("deleted_at").eq("id", s.id).single();
      expect(row!.deleted_at).not.toBeNull();
      expect((await listSources(a.id)).find((x) => x.id === s.id)).toBeUndefined();
      await expect(getSource(a.id, s.id)).rejects.toMatchObject({ status: 404 });
      await expect(softDelete(a.id, s.id, adminA)).rejects.toMatchObject({ status: 404 });
      await expect(setEnabled(a.id, s.id, true, adminA)).rejects.toMatchObject({ status: 404 });
      const { data: logs } = await db().from("audit_log").select("action").eq("target_id", s.id).eq("action", "knowledge.deleted");
      expect(logs).toHaveLength(1);
    });

    it("un operador no puede eliminar ni desactivar (403)", async () => {
      const s = await createSource(a.id, faq("Intocable"), adminA);
      await expect(softDelete(a.id, s.id, operatorA)).rejects.toMatchObject({ status: 403 });
      await expect(setEnabled(a.id, s.id, false, operatorA)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("listSources, getSource y aislamiento", () => {
    it("filtra por tipo, categoría, estado y título", async () => {
      const fresh = await createTestBusiness();
      try {
        const m = await member(fresh, "admin");
        await createSource(fresh.id, { type: "faq", title: "Horarios de atención", category: "hours", question: "q", answer: "a" }, m);
        await createSource(fresh.id, { type: "text", title: "Política de cambios", category: "policies", body: "b" }, m);
        const off = await createSource(fresh.id, { type: "text", title: "Otro texto", body: "b" }, m);
        await setEnabled(fresh.id, off.id, false, m);

        expect(await listSources(fresh.id)).toHaveLength(3);
        expect((await listSources(fresh.id, { type: "text" })).map((s) => s.title).sort()).toEqual(["Otro texto", "Política de cambios"]);
        expect((await listSources(fresh.id, { category: "hours" })).map((s) => s.title)).toEqual(["Horarios de atención"]);
        expect((await listSources(fresh.id, { status: "disabled" })).map((s) => s.title)).toEqual(["Otro texto"]);
        expect((await listSources(fresh.id, { q: "POLÍTICA" })).map((s) => s.title)).toEqual(["Política de cambios"]);
        expect(await listSources(fresh.id, { q: "100%_(x)," })).toEqual([]); // caracteres especiales no rompen la consulta
      } finally {
        await cleanup(fresh.id);
      }
    });

    it("un negocio no ve ni toca las fuentes de otro", async () => {
      const s = await createSource(a.id, faq("Solo de A"), adminA);
      expect((await listSources(b.id)).find((x) => x.id === s.id)).toBeUndefined();
      await expect(getSource(b.id, s.id)).rejects.toMatchObject({ status: 404 });
      await expect(updateSource(b.id, s.id, { title: "hack" }, adminB)).rejects.toMatchObject({ status: 404 });
      await expect(newVersion(s.id, b.id, adminB)).rejects.toMatchObject({ status: 404 });
      await expect(setEnabled(b.id, s.id, false, adminB)).rejects.toMatchObject({ status: 404 });
      await expect(softDelete(b.id, s.id, adminB)).rejects.toMatchObject({ status: 404 });
      expect((await getSource(a.id, s.id)).source.title).toBe("Solo de A");
    });
  });
});
