/**
 * Router de mensajes entrantes (02 §5) a través del webhook real, con la base de desarrollo:
 * reglas 0–5, casos límite 5.4 y la regresión de recordatorios con el chatbot activado.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppointment } from "@/lib/appointments/service";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { qstashFake } from "../fakes/qstash";
import { graphFake } from "../fakes/whatsapp";
import { inDays } from "../helpers/regression";
import { cleanup, createTestBusiness, dbConfigured, insertAppointment, insertSentMessage, RUN_ID, testPhone, type TestBusiness } from "../helpers/supabase-test";
import { inboundPayload, newInboundId, postWebhook, statusPayload } from "../helpers/webhook";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
const PNID = `TESTPNID-${RUN_ID}`;
const ALL_DAY = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "23:59"]]]));

describe.skipIf(!hasDb)("Router de mensajes entrantes", () => {
  let biz: TestBusiness;
  let memberId: string;

  const send = (phone: string, opts: Parameters<typeof inboundPayload>[0] extends infer T ? Partial<T> : never = {}) =>
    postWebhook(inboundPayload({ from: phone, phoneNumberId: PNID, text: "hola", ...opts }));
  const contactOf = async (phone: string) =>
    (await db().from("chat_contacts").select("id, display_name, customer_id").eq("business_id", biz.id).eq("external_id", phone).maybeSingle()).data;
  const convOf = async (phone: string) => {
    const c = await contactOf(phone);
    if (!c) return null;
    return (await db().from("conversations").select("*").eq("contact_id", c.id).neq("status", "closed").maybeSingle()).data;
  };
  const messagesOf = async (phone: string) => {
    const conv = await convOf(phone);
    return conv ? ((await db().from("conversation_messages").select("direction, sender_type, body, content_type, status, wa_message_id").eq("conversation_id", conv.id).order("created_at")).data ?? []) : [];
  };
  const eventsOf = async (conversationId: string) => (await db().from("conversation_events").select("type, payload").eq("conversation_id", conversationId).order("id")).data ?? [];
  const jobs = () => qstashFake.jobs.filter((j) => j.path === "/api/jobs/chatbot-reply");
  const setSettings = (patch: Record<string, unknown>) => db().from("chatbot_settings").update(patch).eq("business_id", biz.id);
  const apptStatus = async (id: string) => (await db().from("appointments").select("status").eq("id", id).single()).data!.status;
  async function withReminder(phone: string, opts: { hoursAgo?: number } = {}) {
    const id = await insertAppointment({ businessId: biz.id, phone, startsAt: inDays(1) });
    const wamid = `wamid.TEST.REMINDER.${id}`;
    await insertSentMessage({ businessId: biz.id, appointmentId: id, phone, wamid });
    if (opts.hoursAgo) await db().from("messages").update({ sent_at: new Date(Date.now() - opts.hoursAgo * 3_600_000).toISOString() }).eq("wa_message_id", wamid);
    return { id, wamid };
  }
  async function conversationInStatus(phone: string, status: "pending_human" | "human" | "resolved") {
    await send(phone, { text: "hola" }); // abre la conversación
    const conv = (await convOf(phone))!;
    const update: Record<string, unknown> = { status };
    if (status === "human") update.assigned_member_id = memberId;
    await db().from("conversations").update(update).eq("id", conv.id);
    if (status === "human") await db().from("conversation_assignments").insert({ conversation_id: conv.id, business_id: biz.id, member_id: memberId });
    qstashFake.reset();
    graphFake.reset();
    return (await convOf(phone))!;
  }

  beforeAll(async () => {
    biz = await createTestBusiness();
    await db().from("businesses").update({ wa_phone_number_id: PNID }).eq("id", biz.id);
    await db().from("chatbot_settings").insert({ business_id: biz.id, enabled: true, llm_model: "fake-1", human_hours: ALL_DAY });
    const { data } = await db().from("business_members").insert({ business_id: biz.id, email: `op-${RUN_ID}@example.test`, display_name: "Ana", role: "operator", status: "active", is_available: true }).select("id").single();
    memberId = data!.id;
  }, 60_000);
  afterAll(async () => {
    await cleanup(biz?.id);
  }, 60_000);
  beforeEach(() => {
    vi.stubEnv("CHATBOT_ENABLED", "true");
    vi.stubEnv("CHATBOT_ALLOWLIST_PHONES", "");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await setSettings({ enabled: true, human_hours: ALL_DAY, answer_questions_on_reminder_replies: true });
  });

  describe("regla 0 · legacy", () => {
    it("interruptor global apagado → legacy: no se crea contacto ni conversación y los recordatorios funcionan", async () => {
      vi.stubEnv("CHATBOT_ENABLED", "false");
      const phone = testPhone();
      const { id, wamid } = await withReminder(phone);
      await send(phone, { text: "1", contextId: wamid });
      expect(await apptStatus(id)).toBe("confirmed");
      expect(await contactOf(phone)).toBeNull();
      expect(jobs()).toHaveLength(0);
    });
    it("phone_number_id desconocido → legacy", async () => {
      const phone = testPhone();
      const { id, wamid } = await withReminder(phone);
      await send(phone, { text: "2", contextId: wamid, phoneNumberId: "desconocido" });
      expect(await apptStatus(id)).toBe("cancelled");
      expect(await contactOf(phone)).toBeNull();
    });
    it("chatbot desactivado en el negocio → legacy", async () => {
      await setSettings({ enabled: false });
      const phone = testPhone();
      await send(phone, { text: "hola, ¿abren hoy?" });
      expect(await contactOf(phone)).toBeNull();
      expect(jobs()).toHaveLength(0);
    });
    it("teléfono fuera de CHATBOT_ALLOWLIST_PHONES → legacy; dentro de la lista → chatbot", async () => {
      const inside = testPhone();
      const outside = testPhone();
      vi.stubEnv("CHATBOT_ALLOWLIST_PHONES", ` +${inside} `);
      await send(outside, { text: "hola" });
      expect(await contactOf(outside)).toBeNull();
      await send(inside, { text: "hola" });
      expect(await convOf(inside)).toMatchObject({ status: "bot" });
    });
    it("legacy con una conversación abierta: el mensaje igual queda en la conversación para el operador (16.11)", async () => {
      const phone = testPhone();
      await conversationInStatus(phone, "pending_human");
      await setSettings({ enabled: false });
      await send(phone, { text: "¿hay novedades?" });
      const msgs = await messagesOf(phone);
      expect(msgs.at(-1)).toMatchObject({ direction: "inbound", body: "¿hay novedades?" });
      expect(jobs()).toHaveLength(0);
    });
  });

  describe("regla 1 · cita un recordatorio", () => {
    it("«1» citando → confirma el turno, evento reminder_reply_routed y ningún job", async () => {
      const phone = testPhone();
      const { id, wamid } = await withReminder(phone);
      await send(phone, { text: "1", contextId: wamid });
      expect(await apptStatus(id)).toBe("confirmed");
      expect(graphFake.texts()[0]).toContain("confirmado");
      expect(jobs()).toHaveLength(0);
      expect((await eventsOf((await convOf(phone))!.id)).map((e) => e.type)).toContain("reminder_reply_routed");
      expect((await messagesOf(phone)).at(-1)).toMatchObject({ direction: "inbound", sender_type: "customer", body: "1" });
    });
    it("5.4 · pregunta citando el recordatorio → aviso «Responde 1 o 2» Y el chatbot responde la pregunta", async () => {
      const phone = testPhone();
      const { id, wamid } = await withReminder(phone);
      await send(phone, { text: "¿Puedo llevar a mi hijo?", contextId: wamid });
      expect(await apptStatus(id)).toBe("scheduled");
      expect(graphFake.texts()).toHaveLength(1);
      expect(jobs()).toHaveLength(1);
    });
    it("con answer_questions_on_reminder_replies=false solo responde el aviso 1/2", async () => {
      await setSettings({ answer_questions_on_reminder_replies: false });
      const phone = testPhone();
      const { wamid } = await withReminder(phone);
      await send(phone, { text: "¿Puedo llevar a mi hijo?", contextId: wamid });
      expect(graphFake.texts()).toHaveLength(1);
      expect(jobs()).toHaveLength(0);
    });
    it("5.4 · en atención humana, «2» citando un recordatorio cancela el turno y no encola la IA", async () => {
      const phone = testPhone();
      await conversationInStatus(phone, "human");
      const { id, wamid } = await withReminder(phone);
      await send(phone, { text: "2", contextId: wamid });
      expect(await apptStatus(id)).toBe("cancelled");
      expect(jobs()).toHaveLength(0);
      expect((await eventsOf((await convOf(phone))!.id)).map((e) => e.type)).toContain("reminder_reply_routed");
    });
  });

  describe("regla 2 · parser estricto sin cita", () => {
    it("5.4 · «1» sin citar, con recordatorio reciente y turno activo → confirma", async () => {
      const phone = testPhone();
      const { id } = await withReminder(phone);
      await send(phone, { text: "1" });
      expect(await apptStatus(id)).toBe("confirmed");
      expect(jobs()).toHaveLength(0);
    });
    it("«no puedo» sin citar → cancela", async () => {
      const phone = testPhone();
      const { id } = await withReminder(phone);
      await send(phone, { text: "no puedo" });
      expect(await apptStatus(id)).toBe("cancelled");
    });
    it("5.4 · cliente sin turno escribe «1» → chatbot", async () => {
      const phone = testPhone();
      await send(phone, { text: "1" });
      expect(jobs()).toHaveLength(1);
    });
    it("«No sé si abren el sábado» con recordatorio reciente → chatbot, el turno no se toca", async () => {
      const phone = testPhone();
      const { id } = await withReminder(phone);
      await send(phone, { text: "No sé si abren el sábado" });
      expect(await apptStatus(id)).toBe("scheduled");
      expect(jobs()).toHaveLength(1);
      expect(graphFake.calls).toHaveLength(0);
    });
    it("«1 pregunta: ¿aceptan tarjeta?» → chatbot", async () => {
      const phone = testPhone();
      const { id } = await withReminder(phone);
      await send(phone, { text: "1 pregunta: ¿aceptan tarjeta?" });
      expect(await apptStatus(id)).toBe("scheduled");
      expect(jobs()).toHaveLength(1);
    });
    it("recordatorio de hace más de 26 h → «1» va al chatbot", async () => {
      const phone = testPhone();
      const { id } = await withReminder(phone, { hoursAgo: 27 });
      await send(phone, { text: "1" });
      expect(await apptStatus(id)).toBe("scheduled");
      expect(jobs()).toHaveLength(1);
    });
  });

  describe("regla 3 · botones de derivación", () => {
    const offer = (conversationId: string, minutesAgo = 1) =>
      db().from("conversations").update({ handoff_offered_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() }).eq("id", conversationId);
    async function offered(phone: string, minutesAgo = 1) {
      await send(phone, { text: "hola" });
      const conv = (await convOf(phone))!;
      await offer(conv.id, minutesAgo);
      qstashFake.reset();
      graphFake.reset();
      return conv.id as string;
    }

    it("H-01 · «Sí» con la oferta vigente → pending_human y confirmación (en horario, con operador disponible)", async () => {
      const phone = testPhone();
      await offered(phone);
      await send(phone, { buttonId: "handoff:yes", text: "Sí, con una persona" });
      const conv = (await convOf(phone))!;
      expect(conv).toMatchObject({ status: "pending_human" });
      expect(conv.handoff_requested_at).not.toBeNull();
      expect(graphFake.texts()).toEqual(["Listo, te paso con una persona del equipo. Te responderán por aquí."]);
      expect(jobs()).toHaveLength(0);
      expect((await eventsOf(conv.id)).map((e) => e.type)).toContain("handoff_accepted");
    });
    it("H-06 · fuera de horario → aviso con la próxima franja y se marca el aviso", async () => {
      await setSettings({ human_hours: {} });
      const phone = testPhone();
      await offered(phone);
      await send(phone, { buttonId: "handoff:yes", text: "Sí, con una persona" });
      expect(graphFake.texts()[0]).toContain("Ahora no hay nadie del equipo disponible");
      expect((await convOf(phone))!.last_out_of_hours_notice_at).not.toBeNull();
    });
    it("sin operadores disponibles también cuenta como fuera de atención", async () => {
      await db().from("business_members").update({ is_available: false }).eq("id", memberId);
      const phone = testPhone();
      await offered(phone);
      await send(phone, { buttonId: "handoff:yes" });
      await db().from("business_members").update({ is_available: true }).eq("id", memberId);
      expect(graphFake.texts()[0]).toContain("Ahora no hay nadie");
    });
    it("H-02 · «No» → sigue el bot, se limpia la oferta y responde «Sigo por aquí»", async () => {
      const phone = testPhone();
      await offered(phone);
      await send(phone, { buttonId: "handoff:no", text: "No, sigo aquí" });
      expect(await convOf(phone)).toMatchObject({ status: "bot", handoff_offered_at: null });
      expect(graphFake.texts()).toEqual(["Sigo por aquí, ¿en qué más te ayudo?"]);
    });
    it("doble toque del botón → un solo cambio y un solo mensaje", async () => {
      const phone = testPhone();
      await offered(phone);
      await send(phone, { buttonId: "handoff:yes" });
      await send(phone, { buttonId: "handoff:yes" });
      expect(graphFake.texts()).toHaveLength(1);
      expect((await eventsOf((await convOf(phone))!.id)).filter((e) => e.type === "handoff_accepted")).toHaveLength(1);
    });
    it("oferta vencida (> 30 min) → no deriva: vuelve a ofrecer con botones", async () => {
      const phone = testPhone();
      await offered(phone, 45);
      await send(phone, { buttonId: "handoff:yes" });
      expect(await convOf(phone)).toMatchObject({ status: "bot" });
      expect(graphFake.interactives()).toHaveLength(1);
      expect(graphFake.interactives()[0].action.buttons.map((b) => b.reply.id)).toEqual(["handoff:yes", "handoff:no"]);
    });
    it("texto «persona» con la oferta vigente → deriva (alternativa a los botones)", async () => {
      const phone = testPhone();
      await offered(phone);
      await send(phone, { text: "Persona" });
      expect(await convOf(phone)).toMatchObject({ status: "pending_human" });
    });
    it("«persona» sin oferta vigente → va al chatbot", async () => {
      const phone = testPhone();
      await send(phone, { text: "persona" });
      expect(await convOf(phone)).toMatchObject({ status: "bot" });
      expect(jobs()).toHaveLength(1);
    });
  });

  describe("regla 4 · conversación con una persona", () => {
    it("pending_human: se guarda, no responde la IA, cuenta como no leído", async () => {
      const phone = testPhone();
      const conv = await conversationInStatus(phone, "pending_human");
      await send(phone, { text: "¿ya viene alguien?" });
      const after = (await convOf(phone))!;
      expect(after.unread_count).toBe(conv.unread_count + 1);
      expect(after.last_inbound_at).not.toBeNull();
      expect((await messagesOf(phone)).at(-1)).toMatchObject({ direction: "inbound", body: "¿ya viene alguien?" });
      expect(jobs()).toHaveLength(0);
      expect(graphFake.calls).toHaveLength(0); // en horario y con operador: sin aviso
    });
    it("H-06 · fuera de horario: un aviso y no otro dentro de las 12 h", async () => {
      await setSettings({ human_hours: {} });
      const phone = testPhone();
      await conversationInStatus(phone, "pending_human");
      await send(phone, { text: "hola?" });
      expect(graphFake.texts()).toHaveLength(1);
      await send(phone, { text: "¿hay alguien?" });
      expect(graphFake.texts()).toHaveLength(1);
      await db().from("conversations").update({ last_out_of_hours_notice_at: new Date(Date.now() - 13 * 3_600_000).toISOString() }).eq("id", (await convOf(phone))!.id);
      await send(phone, { text: "¿sigue sin haber nadie?" });
      expect(graphFake.texts()).toHaveLength(2);
    });
    it("human: se guarda sin respuesta automática ni aviso", async () => {
      await setSettings({ human_hours: {} });
      const phone = testPhone();
      await conversationInStatus(phone, "human");
      await send(phone, { text: "gracias" });
      expect(graphFake.calls).toHaveLength(0);
      expect(jobs()).toHaveLength(0);
      expect((await convOf(phone))!.unread_count).toBeGreaterThan(0);
    });
  });

  describe("regla 5 · chatbot", () => {
    it("primer mensaje: crea contacto (con el nombre del perfil) y conversación, guarda el mensaje y encola el job", async () => {
      const phone = testPhone();
      const wamid = newInboundId();
      await send(phone, { text: "¿A qué hora abren?", id: wamid, profileName: "María Pérez" });
      expect(await contactOf(phone)).toMatchObject({ display_name: "María Pérez", customer_id: null });
      const conv = (await convOf(phone))!;
      expect(conv).toMatchObject({ status: "bot", unread_count: 1 });
      expect((await messagesOf(phone))[0]).toMatchObject({ direction: "inbound", sender_type: "customer", body: "¿A qué hora abren?", content_type: "text" });
      expect(jobs()).toHaveLength(1);
      const msg = (await db().from("conversation_messages").select("id").eq("conversation_id", conv.id).single()).data!;
      expect(jobs()[0]).toMatchObject({
        path: "/api/jobs/chatbot-reply",
        body: { conversationId: conv.id, triggerMessageId: msg.id },
        options: { deduplicationId: `chat-${wamid}`, delaySeconds: 2.5, retries: 3 },
      });
      expect((await eventsOf(conv.id)).map((e) => e.type)).toEqual(["opened"]);
    });
    it("enlaza el contacto con el cliente existente del negocio", async () => {
      const phone = testPhone();
      await insertAppointment({ businessId: biz.id, phone, startsAt: inDays(3) });
      const customer = (await db().from("customers").select("id").eq("business_id", biz.id).eq("phone", phone).single()).data!;
      await send(phone, { text: "¿Dónde quedan?" });
      expect((await contactOf(phone))!.customer_id).toBe(customer.id);
    });
    it("5.4 · mensajes seguidos del mismo contacto: una sola conversación y todos guardados", async () => {
      const phone = testPhone();
      await Promise.all([send(phone, { text: "hola" }), send(phone, { text: "¿están abiertos?" }), send(phone, { text: "quiero un turno" })]);
      const contact = (await contactOf(phone))!;
      const { data: convs } = await db().from("conversations").select("id").eq("contact_id", contact.id);
      expect(convs).toHaveLength(1);
      expect((await messagesOf(phone)).filter((m) => m.direction === "inbound")).toHaveLength(3);
      expect(jobs()).toHaveLength(3); // el job agrupa; la deduplicación es por wamid
    });
    it("el mismo wamid reenviado por Meta no duplica mensaje ni job", async () => {
      const phone = testPhone();
      const id = newInboundId();
      await send(phone, { text: "hola", id });
      await send(phone, { text: "hola", id });
      expect((await messagesOf(phone)).filter((m) => m.direction === "inbound")).toHaveLength(1);
      expect(jobs()).toHaveLength(1);
    });
    it("un cliente que escribe tras quedar resuelta la conversación la reabre (T10)", async () => {
      const phone = testPhone();
      await conversationInStatus(phone, "resolved");
      await send(phone, { text: "una consulta más" });
      const conv = (await convOf(phone))!;
      expect(conv.status).toBe("bot");
      expect((await eventsOf(conv.id)).map((e) => e.type)).toContain("reopened");
      expect(jobs()).toHaveLength(1);
    });
    it("audio: se guarda con su tipo y se encola (el motor responde con el mensaje de contenido no soportado)", async () => {
      const phone = testPhone();
      await send(phone, { type: "audio", text: undefined });
      expect((await messagesOf(phone))[0]).toMatchObject({ content_type: "audio", body: null });
      expect(jobs()).toHaveLength(1);
    });
  });

  describe("estados de mensajes", () => {
    it("los estados de un mensaje del bot actualizan conversation_messages sin pisar el ranking; los de recordatorios siguen como antes", async () => {
      const phone = testPhone();
      const conv = await conversationInStatus(phone, "pending_human");
      const wamid = `wamid.TEST.BOT.${RUN_ID}`;
      await db().from("conversation_messages").insert({ conversation_id: conv.id, business_id: biz.id, direction: "outbound", sender_type: "bot", body: "x", status: "accepted", wa_message_id: wamid });
      await postWebhook(statusPayload(wamid, "read", phone));
      await postWebhook(statusPayload(wamid, "delivered", phone)); // llega tarde: no baja de read
      const row = (await db().from("conversation_messages").select("status, read_at, delivered_at").eq("wa_message_id", wamid).single()).data!;
      expect(row.status).toBe("read");
      expect(row.read_at).not.toBeNull();
      expect(row.delivered_at).toBeNull();

      const { wamid: reminderWamid } = await withReminder(phone);
      await postWebhook(statusPayload(reminderWamid, "delivered", phone));
      expect((await db().from("messages").select("status").eq("wa_message_id", reminderWamid).single()).data!.status).toBe("delivered");
    });
    it("un estado de un mensaje desconocido se ignora", async () => {
      const res = await postWebhook(statusPayload("wamid.DESCONOCIDO", "read", testPhone()));
      expect(res.status).toBe(200);
    });
  });

  describe("recordatorios con el chatbot activado (regresión)", () => {
    it("un recordatorio nuevo se sigue programando igual (createAppointment)", async () => {
      const phone = testPhone();
      const result = await createAppointment({ businessId: biz.id, customerName: "Cliente", customerPhone: phone, startsAt: inDays(3), service: "Corte" });
      expect(result.appointment.id).toBeTruthy();
      expect(qstashFake.scheduled.length).toBeGreaterThan(0);
    });
  });
});
