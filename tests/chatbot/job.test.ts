/**
 * Job chatbot-reply de punta a punta (webhook → cola → motor → WhatsApp), con proveedores falsos y la base de desarrollo.
 * Cubre W-01…W-06 de 09 §22: respuesta, reintentos sin duplicar, fallos de envío, límites y derivación.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/jobs/chatbot-reply/route";
import type { BotOutput } from "@/lib/chatbot/engine/schema";
import { fakeEmbeddings, fakeLlm } from "@/lib/chatbot/providers/fake";
import { claimConversation, returnToBot } from "@/lib/chatbot/conversations/operator";
import { ProviderError } from "@/lib/chatbot/providers/types";
import { ingestDocument } from "@/lib/chatbot/rag/ingest";
import { createSource, getSource } from "@/lib/chatbot/rag/sources";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { qstashFake, VALID_QSTASH_SIGNATURE } from "../fakes/qstash";
import { graphFake } from "../fakes/whatsapp";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, testPhone, type TestBusiness } from "../helpers/supabase-test";
import { inboundPayload, postWebhook } from "../helpers/webhook";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
const PNID = `TESTJOB-${RUN_ID}`;
const ALL_DAY = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "23:59"]]]));

const answer = (over: Partial<BotOutput> = {}): BotOutput => ({
  intent: "question", answer: "Atendemos de lunes a viernes de 9 a 18 horas.", grounded: true, used_source_ids: ["c1"], confidence: 0.9,
  needs_human: false, needs_clarification: false, missing_info: null, ...over,
});

describe.skipIf(!hasDb)("Job chatbot-reply", () => {
  let biz: TestBusiness;
  let memberId: string;

  const jobRequest = (body: unknown, signature: string | null = VALID_QSTASH_SIGNATURE) =>
    new Request("http://localhost:3000/api/jobs/chatbot-reply", {
      method: "POST",
      headers: { "content-type": "application/json", ...(signature && { "upstash-signature": signature }) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const lastJob = () => qstashFake.jobs.filter((j) => j.path === "/api/jobs/chatbot-reply").at(-1)!.body as { conversationId: string; triggerMessageId: string };
  const runJob = async (body = lastJob()) => POST(jobRequest(body));
  const inbound = (phone: string, text: string, extra: Record<string, unknown> = {}) => postWebhook(inboundPayload({ from: phone, phoneNumberId: PNID, text, ...extra }));
  const conv = async (phone: string) => {
    const c = (await db().from("chat_contacts").select("id").eq("business_id", biz.id).eq("external_id", phone).single()).data!;
    return (await db().from("conversations").select("*").eq("contact_id", c.id).neq("status", "closed").single()).data!;
  };
  const outbound = async (phone: string) =>
    (await db().from("conversation_messages").select("sender_type, body, status, wa_message_id, reply_to_message_id, content_type, ai").eq("conversation_id", (await conv(phone)).id).eq("direction", "outbound").order("created_at")).data!;
  const setSettings = (patch: Record<string, unknown>) => db().from("chatbot_settings").update(patch).eq("business_id", biz.id);

  beforeAll(async () => {
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "fake-1");
    biz = await createTestBusiness();
    await db().from("businesses").update({ wa_phone_number_id: PNID }).eq("id", biz.id);
    await db().from("chatbot_settings").insert({ business_id: biz.id, enabled: true, llm_model: "fake-1", human_hours: ALL_DAY });
    const { data } = await db().from("business_members").insert({ business_id: biz.id, email: `op-${RUN_ID}@example.test`, display_name: "Ana", role: "operator", status: "active", is_available: true }).select("id").single();
    memberId = data!.id;
    const admin = { id: memberId, userId: null, businessId: biz.id, role: "admin" as const, displayName: "Ana", legacy: false };
    const s = await createSource(biz.id, { type: "faq", title: "Horarios", question: "¿Cuál es el horario de atención?", answer: "Atendemos de lunes a viernes de 9 a 18 horas." }, admin);
    await ingestDocument((await getSource(biz.id, s.id)).versions[0].id, { embeddings: fakeEmbeddings });
  }, 120_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup(biz?.id);
  }, 60_000);
  beforeEach(() => {
    vi.stubEnv("CHATBOT_ENABLED", "true");
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "fake-1");
    fakeLlm.requests = [];
    fakeLlm.handler = (req) => (req.system.includes("prepara a una persona") ? { output: { summary: "El cliente preguntó por el horario y pidió hablar con alguien." } } : { output: answer() });
    qstashFake.reset();
    graphFake.reset();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await setSettings({ enabled: true, human_hours: ALL_DAY, monthly_budget_usd: 20 });
  });

  it("W-01 · responde la pregunta con la fuente del negocio, registra la respuesta, el uso y los estados", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    const res = await runJob();
    expect(await res.json()).toEqual({ outcome: "sent" });

    expect(graphFake.texts()).toEqual([expect.stringContaining("Atendemos de lunes a viernes de 9 a 18 horas.")]);
    const out = await outbound(phone);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sender_type: "bot", status: "accepted", wa_message_id: graphFake.lastWamid, reply_to_message_id: lastJob().triggerMessageId, ai: { source: "ai", used_source_ids: ["c1"] } });
    expect((await conv(phone)).consecutive_failures).toBe(0);
    const { data: usage } = await db().from("chatbot_usage").select("operation, conversation_id").eq("business_id", biz.id).eq("conversation_id", lastJob().conversationId);
    expect(usage!.map((u) => u.operation)).toContain("chat");
    expect(fakeLlm.requests[0].context).toContain("Atendemos de lunes a viernes");
  });

  it("W-02 · un reintento del mismo job (QStash) no duplica la respuesta", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    const job = lastJob();
    await runJob(job);
    const again = await runJob(job);
    expect(await again.json()).toEqual({ outcome: "skipped", reason: "already_replied" });
    expect(graphFake.texts()).toHaveLength(1);
    expect(await outbound(phone)).toHaveLength(1);
  });

  it("W-03 · ráfaga de mensajes: el primer job queda superado y el último responde a todos juntos", async () => {
    const phone = testPhone();
    await inbound(phone, "hola, quería saber");
    const first = lastJob();
    await inbound(phone, "¿cuál es el horario de atención de la tienda?");
    expect(await (await runJob(first)).json()).toEqual({ outcome: "skipped", reason: "superseded" });
    expect(graphFake.calls).toHaveLength(0);

    await runJob();
    expect(graphFake.texts()).toHaveLength(1);
    expect(fakeLlm.requests[0].history.at(-1)!.content).toBe("hola, quería saber\n¿cuál es el horario de atención de la tienda?");
  });

  it("saludo y agradecimiento se responden sin llamar a la IA", async () => {
    const phone = testPhone();
    await inbound(phone, "hola");
    await runJob();
    expect(graphFake.texts()[0]).toContain("Soy el asistente virtual");
    await inbound(phone, "gracias!!");
    await runJob();
    expect(graphFake.texts()[1]).toBe("¡De nada! Si necesitas algo más, aquí estoy.");
    expect(fakeLlm.requests).toHaveLength(0);
  });

  it("W-04 · sin información: «no sé», pregunta sin respuesta y, al segundo fallo, botones de derivación", async () => {
    fakeLlm.handler = () => ({ output: answer({ grounded: false, used_source_ids: [], answer: "No sé", missing_info: "precio del tinte" }) });
    const phone = testPhone();
    await inbound(phone, "¿Cuánto cuesta el tinte para el pelo largo?");
    await runJob();
    expect(graphFake.texts()).toEqual(["No tengo esa información. Si quieres, te comunico con una persona del equipo."]);
    expect((await conv(phone)).consecutive_failures).toBe(1);
    const { data: unanswered } = await db().from("unanswered_questions").select("question, reason, status").eq("conversation_id", (await conv(phone)).id);
    expect(unanswered).toEqual([{ question: "¿Cuánto cuesta el tinte para el pelo largo?", reason: "no_context", status: "open" }]);

    await inbound(phone, "¿y el tinte para el pelo corto cuánto sale?");
    await runJob();
    expect(graphFake.interactives()).toHaveLength(1);
    expect(graphFake.interactives()[0].action.buttons.map((b) => b.reply.id)).toEqual(["handoff:yes", "handoff:no"]);
    expect(await conv(phone)).toMatchObject({ consecutive_failures: 2, handoff_reason: "no_information" });
    expect((await conv(phone)).handoff_offered_at).not.toBeNull();
  });

  it("H-01 · flujo completo: el cliente pide una persona, acepta con el botón y queda en pending_human con resumen", async () => {
    fakeLlm.handler = (req) => (req.system.includes("prepara a una persona") ? { output: { summary: "Quiere hablar con una persona sobre su turno." } } : { output: answer({ intent: "human_request", answer: "Claro", used_source_ids: [] }) });
    const phone = testPhone();
    await inbound(phone, "quiero hablar con una persona");
    await runJob();
    expect(graphFake.interactives()).toHaveLength(1);
    expect(await conv(phone)).toMatchObject({ status: "bot", handoff_reason: "customer_request" });

    await inbound(phone, "Sí, con una persona", { buttonId: "handoff:yes" });
    const c = await conv(phone);
    expect(c.status).toBe("pending_human");
    expect(graphFake.texts().at(-1)).toContain("te paso con una persona");
    expect(c.summary).toBe("Quiere hablar con una persona sobre su turno.");
    const { data: usage } = await db().from("chatbot_usage").select("operation").eq("conversation_id", c.id).eq("operation", "summary");
    expect(usage).toHaveLength(1);
  });

  it("W-05 (spec) · proveedor de IA caído: 500 para que QStash reintente y, en el último intento, mensaje de «sin información» con la oferta", async () => {
    fakeLlm.handler = () => {
      throw new ProviderError("sobrecargado", true, 529);
    };
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    expect((await runJob()).status).toBe(500);
    expect(graphFake.calls).toHaveLength(0);

    const last = lastJob();
    const final = await POST(
      new Request("http://localhost:3000/api/jobs/chatbot-reply", {
        method: "POST",
        headers: { "content-type": "application/json", "upstash-signature": VALID_QSTASH_SIGNATURE, "upstash-retried": "3" },
        body: JSON.stringify(last),
      }),
    );
    expect(final.status).toBe(200);
    expect(graphFake.interactives()).toHaveLength(1); // mensaje de «sin información» + oferta con botones
    expect(JSON.stringify(graphFake.interactives()[0])).toContain("No tengo esa información");
    expect(graphFake.interactives()[0].action.buttons.map((b) => b.reply.id)).toEqual(["handoff:yes", "handoff:no"]);
    expect(await outbound(phone)).toHaveLength(1);
  });

  it("H-07 · «Devolver a la IA» y el cliente pregunta: la IA responde con el historial de la conversación", async () => {
    const phone = testPhone();
    await inbound(phone, "Hola, soy María");
    await runJob();
    const c = await conv(phone);
    const op = { id: memberId, userId: null, businessId: biz.id, role: "admin" as const, displayName: "Ana", legacy: false };
    await claimConversation(op, c.id);
    expect((await conv(phone)).status).toBe("human");
    await returnToBot(op, c.id);
    expect((await conv(phone)).status).toBe("bot");

    graphFake.reset();
    fakeLlm.requests = [];
    await inbound(phone, "¿Cuál es el horario de atención?");
    await runJob();
    expect(graphFake.texts()).toEqual([expect.stringContaining("Atendemos de lunes a viernes")]);
    expect(fakeLlm.requests[0].history.map((h) => h.content).join(" ")).toContain("Hola, soy María");
  });

  it("falla transitoria de WhatsApp → 500 (QStash reintenta) y el reintento envía UNA sola respuesta", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    graphFake.failNext(500);
    expect((await runJob()).status).toBe(500);
    expect((await outbound(phone))[0]).toMatchObject({ status: "queued", wa_message_id: null });

    const retry = await runJob();
    expect(await retry.json()).toEqual({ outcome: "sent" });
    const out = await outbound(phone);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "accepted" });
    expect(out[0].wa_message_id).toBeTruthy();
  });

  it("rechazo permanente de WhatsApp (400) → 200 sin reintento, mensaje failed y evento send_failed", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    graphFake.failNext(400, "Número no válido");
    const res = await runJob();
    expect(res.status).toBe(200);
    expect((await outbound(phone))[0]).toMatchObject({ status: "failed" });
    const { data: events } = await db().from("conversation_events").select("type").eq("conversation_id", (await conv(phone)).id).eq("type", "send_failed");
    expect(events).toHaveLength(1);
  });

  it("ventana de 24 h cerrada → no se envía (WhatsApp solo admite plantillas) y queda registrado", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    await db().from("conversation_messages").update({ created_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }).eq("conversation_id", lastJob().conversationId).eq("direction", "inbound");
    const res = await runJob();
    expect(res.status).toBe(200);
    expect(graphFake.calls).toHaveLength(0);
    expect((await outbound(phone))[0]).toMatchObject({ status: "failed" });
  });

  it("presupuesto agotado → «sin información» con botones y sin llamar a la IA (budget_exhausted)", async () => {
    await setSettings({ monthly_budget_usd: 0 });
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    await runJob();
    expect(fakeLlm.requests).toHaveLength(0);
    expect(graphFake.interactives()).toHaveLength(1);
    expect(await conv(phone)).toMatchObject({ handoff_reason: "budget_exhausted" });
    const { data: events } = await db().from("conversation_events").select("type").eq("conversation_id", (await conv(phone)).id).eq("type", "budget_exhausted");
    expect(events).toHaveLength(1);
  });

  it("chatbot apagado cuando corre el job → se omite sin enviar nada", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    await setSettings({ enabled: false });
    expect(await (await runJob()).json()).toEqual({ outcome: "skipped", reason: "chatbot_disabled" });
    vi.stubEnv("CHATBOT_ENABLED", "false");
    await setSettings({ enabled: true });
    expect(await (await runJob()).json()).toEqual({ outcome: "skipped", reason: "chatbot_disabled" });
    expect(graphFake.calls).toHaveLength(0);
  });

  it("si la conversación pasó a una persona antes de correr el job, no responde la IA", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    const c = await conv(phone);
    await db().from("conversations").update({ status: "human", assigned_member_id: memberId }).eq("id", c.id);
    await db().from("conversation_assignments").insert({ conversation_id: c.id, business_id: biz.id, member_id: memberId });
    expect(await (await runJob()).json()).toEqual({ outcome: "skipped", reason: "not_bot_conversation" });
    expect(graphFake.calls).toHaveLength(0);
  });

  it("W-05 · mientras otro turno tiene el lease de la conversación → 500 para que QStash reintente", async () => {
    const phone = testPhone();
    await inbound(phone, "¿Cuál es el horario de atención?");
    await db().from("conversations").update({ bot_lock_until: new Date(Date.now() + 60_000).toISOString() }).eq("id", lastJob().conversationId);
    expect((await runJob()).status).toBe(500);
    expect(graphFake.calls).toHaveLength(0);
    await db().from("conversations").update({ bot_lock_until: null }).eq("id", lastJob().conversationId);
    expect((await runJob()).status).toBe(200);
    expect((await db().from("conversations").select("bot_lock_until").eq("id", lastJob().conversationId).single()).data!.bot_lock_until).toBeNull(); // el lease se libera
  });

  it("S-08 / validación · sin firma → 401; cuerpo inválido → 400; conversación inexistente → omitida", async () => {
    expect((await POST(jobRequest({ conversationId: crypto.randomUUID(), triggerMessageId: crypto.randomUUID() }, null))).status).toBe(401);
    expect((await POST(jobRequest({ conversationId: crypto.randomUUID(), triggerMessageId: crypto.randomUUID() }, "firma-falsa"))).status).toBe(401);
    expect((await POST(jobRequest("{no es json"))).status).toBe(400);
    expect((await POST(jobRequest({ conversationId: "x", triggerMessageId: "y" }))).status).toBe(400);
    expect(await (await POST(jobRequest({ conversationId: crypto.randomUUID(), triggerMessageId: crypto.randomUUID() }))).json()).toEqual({ outcome: "skipped", reason: "conversation_not_found" });
    expect(graphFake.calls).toHaveLength(0);
  });

  it("5.4 · audio: respuesta fija de contenido no soportado y pregunta sin respuesta, sin IA", async () => {
    const phone = testPhone();
    await inbound(phone, "", { type: "audio" });
    await runJob();
    expect(graphFake.texts()).toEqual(["Por ahora solo puedo leer mensajes de texto."]);
    expect(fakeLlm.requests).toHaveLength(0);
    const { data } = await db().from("unanswered_questions").select("reason").eq("conversation_id", (await conv(phone)).id);
    expect(data).toEqual([{ reason: "unsupported_content" }]);
  });
});
