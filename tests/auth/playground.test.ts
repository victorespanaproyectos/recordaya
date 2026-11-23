/** Zona de pruebas (T-07.6) contra la base real, con embeddings y generación falsos. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMinRole } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { runPlayground } from "@/lib/chatbot/engine/playground";
import type { BotOutput } from "@/lib/chatbot/engine/schema";
import { FakeLlmProvider, fakeEmbeddings } from "@/lib/chatbot/providers/fake";
import { ingestDocument } from "@/lib/chatbot/rag/ingest";
import { createSource, getSource } from "@/lib/chatbot/rag/sources";
import { upsertChatbotSettings } from "@/lib/chatbot/settings";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
const state: { member: Member | null } = { member: null };
vi.mock("@/lib/auth/session", () => ({
  requireMember: async (min: Member["role"]) => {
    if (!state.member) throw new Error("NEXT_REDIRECT");
    if (!hasMinRole(state.member.role, min)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return state.member;
  },
}));
import { testChatbotAction } from "@/app/panel/chatbot/pruebas/actions";

const out = (over: Partial<BotOutput> = {}): BotOutput => ({
  intent: "question", answer: "Atendemos de lunes a viernes de 9 a 18 horas.", grounded: true, used_source_ids: ["c1"], confidence: 0.9,
  needs_human: false, needs_clarification: false, missing_info: null, ...over,
});

describe.skipIf(!hasDb)("zona de pruebas", () => {
  let biz: TestBusiness;
  let admin: Member;
  let llm: FakeLlmProvider;

  beforeAll(async () => {
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "fake-1");
    biz = await createTestBusiness();
    const { data } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `admin-${RUN_ID}@example.test`, display_name: "admin", role: "admin", status: "active" })
      .select("id")
      .single();
    admin = { id: data!.id, userId: null, businessId: biz.id, role: "admin", displayName: "admin", legacy: false };
    await db().from("chatbot_settings").insert({ business_id: biz.id, llm_model: "fake-1" });
    await upsertChatbotSettings(biz.id, { enabled: true, human_hours: { mon: [["09:00", "18:00"]] } }, { ...admin, role: "admin" });

    const s = await createSource(biz.id, { type: "faq", title: "Horarios", question: "¿Cuál es el horario de atención?", answer: "Atendemos de lunes a viernes de 9 a 18 horas." }, admin);
    await ingestDocument((await getSource(biz.id, s.id)).versions[0].id, { embeddings: fakeEmbeddings });
    state.member = admin;
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup(biz?.id);
  }, 60_000);
  beforeEach(() => {
    llm = new FakeLlmProvider();
    llm.handler = () => ({ output: out() });
    state.member = admin;
  });

  const run = (messages: { role: "user" | "assistant"; text: string }[]) => runPlayground(biz.id, messages, { llm: () => llm });
  const convCount = async () => (await db().from("conversations").select("id", { count: "exact", head: true }).eq("business_id", biz.id)).count;

  it("responde con la fuente real del negocio, devuelve fragmentos y JSON, y no persiste conversaciones", async () => {
    const r = await run([{ role: "user", text: "¿Cuál es el horario de atención?" }]);
    expect(r.reply).toBe("¡Hola! Soy el asistente virtual de " + biz.name + ". ¿En qué te ayudo?\n\nAtendemos de lunes a viernes de 9 a 18 horas.");
    expect(r.debug!.chunks[0]).toMatchObject({ ref: "c1", title: "Horarios" });
    expect(r.debug!.output).toEqual(out());
    expect(r.debug!.model).toBe("fake-1");
    expect(llm.requests[0].context).toContain("Atendemos de lunes a viernes");
    expect(await convCount()).toBe(0);
    expect((await db().from("conversation_messages").select("id", { count: "exact", head: true }).eq("business_id", biz.id)).count).toBe(0);
  });

  it("registra el consumo como 'playground' (y la consulta de recuperación)", async () => {
    await run([{ role: "user", text: "horario de atención" }]);
    const { data } = await db().from("chatbot_usage").select("operation, conversation_id").eq("business_id", biz.id);
    expect(data!.map((r) => r.operation).sort()).toEqual(expect.arrayContaining(["playground", "embedding_query"]));
    expect(data!.every((r) => r.conversation_id === null)).toBe(true);
  });

  it("usa la conversación previa como historial y no antepone la bienvenida fuera del primer mensaje", async () => {
    const r = await run([
      { role: "user", text: "hola" },
      { role: "assistant", text: "¡Hola! ¿En qué te ayudo?" },
      { role: "user", text: "¿cuál es el horario de atención de hoy?" },
    ]);
    expect(r.reply).toBe("Atendemos de lunes a viernes de 9 a 18 horas.");
    expect(llm.requests[0].history.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
  });

  it("incluye el horario de atención humana del negocio en el contexto", async () => {
    await run([{ role: "user", text: "¿hay alguien del equipo?" }]);
    expect(llm.requests[0].context).toMatch(/atención humana: (disponible ahora|próxima: )/);
  });

  it("muestra la guarda que descartó la respuesta", async () => {
    llm.handler = () => ({ output: out({ answer: "El corte cuesta $999." }) });
    const r = await run([{ role: "user", text: "¿cuál es el horario de atención y el precio del corte?" }]);
    expect(r.debug!.guard).toBe("facts");
    expect(r.reply).toContain("No tengo esa información");
  });

  it("valida la entrada", async () => {
    await expect(run([])).rejects.toMatchObject({ status: 400 });
    await expect(run([{ role: "user", text: "x" }, { role: "assistant", text: "y" }])).rejects.toMatchObject({ message: expect.stringContaining("cliente") });
    await expect(run([{ role: "user", text: "   " }])).rejects.toMatchObject({ status: 400 });
    await expect(run([{ role: "user", text: "x".repeat(2001) }])).rejects.toMatchObject({ message: expect.stringContaining("2000") });
    await expect(run(Array.from({ length: 21 }, () => ({ role: "user" as const, text: "x" })))).rejects.toMatchObject({ status: 400 });
  });

  it("sin CHATBOT_DEFAULT_MODEL y con 'default' explica qué falta", async () => {
    await db().from("chatbot_settings").update({ llm_model: "default" }).eq("business_id", biz.id);
    vi.stubEnv("CHATBOT_DEFAULT_MODEL", "");
    await expect(run([{ role: "user", text: "hola" }])).rejects.toMatchObject({ message: expect.stringContaining("CHATBOT_DEFAULT_MODEL") });
    await db().from("chatbot_settings").update({ llm_model: "fake-1" }).eq("business_id", biz.id);
  });

  describe("acción", () => {
    it("un operador no puede usarla (403) ni tampoco sin sesión", async () => {
      state.member = { ...admin, role: "operator" };
      await expect(testChatbotAction([{ role: "user", text: "hola" }])).rejects.toThrow("403");
      state.member = null;
      await expect(testChatbotAction([{ role: "user", text: "hola" }])).rejects.toThrow("NEXT_REDIRECT");
    });
    it("errores de validación llegan como mensaje", async () => {
      expect(await testChatbotAction([])).toEqual({ ok: false, error: "Escribe un mensaje para probar" });
    });
  });
});
