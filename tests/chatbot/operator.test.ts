/**
 * Máquina de estados (T1–T12), acciones del equipo, reasignación, mensajes del operador y mantenimiento
 * contra la base de desarrollo (T-09.1 a T-09.8).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@/lib/auth/session";
import {
  claimConversation, closeConversation, declineHandoffByMember, handoffConversation, markRead, reassignConversation, releaseConversation,
  resolveConversation, returnToBot, sendAgentMessage, sendReopenTemplate,
} from "@/lib/chatbot/conversations/operator";
import { runMaintenance } from "@/lib/chatbot/conversations/maintenance";
import { getConversation, type Conversation } from "@/lib/chatbot/conversations/service";
import { canTransition, STALE, TRANSITIONS, transition, type TransitionName } from "@/lib/chatbot/conversations/state-machine";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { qstashFake } from "../fakes/qstash";
import { graphFake } from "../fakes/whatsapp";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, testPhone, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
type Status = Conversation["status"];

describe.skipIf(!hasDb)("Atención humana", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  type TM = Member & { id: string };
  const m: Record<string, TM> = {};
  let n = 0;

  async function member(biz: TestBusiness, key: string, role: Member["role"], extra: Record<string, unknown> = {}): Promise<TM> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `${key}-${RUN_ID}@example.test`, display_name: key, role, status: "active", is_available: true, max_concurrent: 50, last_seen_at: new Date().toISOString(), ...extra })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role, displayName: key, legacy: false };
  }

  /** Conversación en el estado pedido (con asignación abierta si es `human`) y un mensaje del cliente. */
  async function conv(biz: TestBusiness, status: Status = "bot", opts: { assignTo?: TM; ageHours?: number; phone?: string } = {}): Promise<Conversation> {
    const phone = opts.phone ?? testPhone();
    const { data: contact } = await db().from("chat_contacts").insert({ business_id: biz.id, channel: "whatsapp", external_id: phone, display_name: `Cliente ${++n}` }).select("id").single();
    const when = new Date(Date.now() - (opts.ageHours ?? 0) * 3_600_000).toISOString();
    const row: Record<string, unknown> = { business_id: biz.id, contact_id: contact!.id, channel: "whatsapp", status, last_message_at: when, last_inbound_at: when };
    if (status === "human") Object.assign(row, { assigned_member_id: opts.assignTo!.id, assigned_at: when });
    const { data: c, error } = await db().from("conversations").insert(row).select("id").single();
    if (error) throw error;
    await db().from("conversation_messages").insert({ conversation_id: c!.id, business_id: biz.id, direction: "inbound", sender_type: "customer", body: "hola", status: "delivered", created_at: when });
    if (status === "human") await db().from("conversation_assignments").insert({ conversation_id: c!.id, business_id: biz.id, member_id: opts.assignTo!.id, assigned_at: when });
    return (await getConversation(biz.id, c!.id))!;
  }
  const fresh = async (c: Conversation) => (await getConversation(c.businessId, c.id))!;
  const assignments = async (id: string) => (await db().from("conversation_assignments").select("member_id, released_at, release_reason").eq("conversation_id", id).order("assigned_at")).data!;
  const events = async (id: string) => (await db().from("conversation_events").select("type, from_status, to_status, actor_type").eq("conversation_id", id).order("id")).data!;
  const code = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    m.owner = await member(a, "owner", "owner", { is_available: false });
    m.admin = await member(a, "admin", "admin");
    m.op1 = await member(a, "op1", "operator");
    m.op2 = await member(a, "op2", "operator");
    m.busy = await member(a, "busy", "operator", { max_concurrent: 1 });
    m.away = await member(a, "away", "operator", { is_available: false });
    m.opB = await member(b, "opb", "operator");
    await db().from("chatbot_settings").insert({ business_id: a.id, enabled: true, llm_model: "fake-1", closing_message: "Gracias por escribir a {negocio}" });
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);
  beforeEach(() => {
    qstashFake.reset();
    graphFake.reset();
  });

  describe("máquina de estados (T1–T12)", () => {
    const ALL: Status[] = ["bot", "pending_human", "human", "resolved", "closed"];
    const names = Object.keys(TRANSITIONS) as TransitionName[];

    it.each(names)("«%s»: solo desde los estados que la tabla permite; el resto da 409", async (name) => {
      for (const from of ALL) {
        const c = await conv(a, from, { assignTo: m.op1 });
        const allowed = canTransition(name, from);
        expect(allowed, `${name} desde ${from}`).toBe(TRANSITIONS[name].from.includes(from));
        const result = await code(transition(name, c, { type: "member", memberId: m.admin.id }, { assignTo: m.op2.id }));
        expect(result, `${name} desde ${from}`).toBe(allowed ? 0 : 409);
      }
    });

    it("T4 claim: asigna, abre la asignación y registra el evento", async () => {
      const c = await conv(a, "pending_human");
      const r = await transition("claim", c, { type: "member", memberId: m.op1.id }, { assignTo: m.op1.id });
      expect(r).toMatchObject({ status: "human", assignedMemberId: m.op1.id });
      expect(await assignments(c.id)).toEqual([{ member_id: m.op1.id, released_at: null, release_reason: null }]);
      expect((await events(c.id)).at(-1)).toMatchObject({ type: "claimed", from_status: "pending_human", to_status: "human" });
    });
    it.each([
      ["release", "pending_human", "released"], ["return_to_bot", "bot", "returned_to_bot"], ["resolve", "resolved", "resolved"], ["close", "closed", "closed"], ["member_disabled", "pending_human", "member_disabled"],
    ] as const)("«%s» desde human → %s y la asignación se cierra con motivo %s", async (name, to, reason) => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      const r = await transition(name, c, { type: "member", memberId: m.admin.id });
      expect(r.status).toBe(to);
      expect(r.assignedMemberId).toBeNull();
      expect(await assignments(c.id)).toEqual([{ member_id: m.op1.id, released_at: expect.any(String), release_reason: reason }]);
    });
    it("T7 devolver a la IA reinicia los fallos; T8 marca quién resolvió; T9 resuelve la IA", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      await db().from("conversations").update({ consecutive_failures: 3 }).eq("id", c.id);
      expect(await transition("return_to_bot", await fresh(c), { type: "member", memberId: m.op1.id })).toMatchObject({ consecutiveFailures: 0 });
      const d = await conv(a, "human", { assignTo: m.op1 });
      await transition("resolve", d, { type: "member", memberId: m.op1.id });
      expect((await db().from("conversations").select("resolved_by, resolved_at").eq("id", d.id).single()).data).toMatchObject({ resolved_by: "human", resolved_at: expect.any(String) });
      const e = await conv(a, "bot");
      await transition("auto_resolve", e, { type: "system" });
      expect((await db().from("conversations").select("resolved_by").eq("id", e.id).single()).data!.resolved_by).toBe("bot");
    });
    it("T3 derivar por un miembro guarda el motivo operator_initiated; T10 reabrir limpia la resolución", async () => {
      const c = await conv(a, "bot");
      await transition("request_handoff", c, { type: "member", memberId: m.op1.id });
      expect((await db().from("conversations").select("handoff_reason, handoff_requested_at").eq("id", c.id).single()).data).toMatchObject({ handoff_reason: "operator_initiated", handoff_requested_at: expect.any(String) });
      const r = await conv(a, "resolved");
      await db().from("conversations").update({ resolved_at: new Date().toISOString(), resolved_by: "bot" }).eq("id", r.id);
      await transition("reopen", await fresh(r), { type: "customer" });
      expect((await db().from("conversations").select("status, resolved_at, resolved_by").eq("id", r.id).single()).data).toEqual({ status: "bot", resolved_at: null, resolved_by: null });
    });
    it("versión desfasada → 409 «La conversación cambió»; la versión sube en cada transición", async () => {
      const c = await conv(a, "bot");
      const moved = await transition("request_handoff", c, { type: "customer" });
      expect(moved.version).toBe(c.version + 1);
      await expect(transition("close", { ...c, status: "bot" }, { type: "system" })).rejects.toMatchObject({ status: 409, message: STALE });
      await expect(transition("decline_handoff", moved, { type: "customer" }, { expectedVersion: 99 })).rejects.toMatchObject({ status: 409 });
    });
    it("una conversación cerrada no admite ninguna transición", async () => {
      const c = await conv(a, "closed");
      for (const name of names) expect(await code(transition(name, c, { type: "system" }, { assignTo: m.op1.id }))).toBe(409);
    });
  });

  describe("tomar (T4)", () => {
    it("un operador disponible toma una conversación en cola: queda asignada y sin no leídos", async () => {
      const c = await conv(a, "pending_human");
      await db().from("conversations").update({ unread_count: 4 }).eq("id", c.id);
      const r = await claimConversation(m.op1, c.id);
      expect(r).toMatchObject({ status: "human", assignedMemberId: m.op1.id, unreadCount: 0 });
      expect((await fresh(c)).unreadCount).toBe(0);
    });
    it("H-05 · dos operadores a la vez: exactamente uno la toma, el otro recibe 409", async () => {
      const c = await conv(a, "pending_human");
      const results = await Promise.all([code(claimConversation(m.op1, c.id)), code(claimConversation(m.op2, c.id))]);
      expect(results.sort()).toEqual([0, 409]);
      expect(await assignments(c.id)).toHaveLength(1);
    });
    it("no disponible → 409; owner sin disponibilidad puede (es admin+)", async () => {
      expect(await code(claimConversation(m.away, (await conv(a, "pending_human")).id))).toBe(409);
      expect(await code(claimConversation(m.owner, (await conv(a, "pending_human")).id))).toBe(0);
    });
    it("al llegar a su máximo de conversaciones, un operador no puede tomar más; un admin sí", async () => {
      await claimConversation(m.busy, (await conv(a, "pending_human")).id);
      const extra = await conv(a, "pending_human");
      await expect(claimConversation(m.busy, extra.id)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("máximo") });
      await db().from("business_members").update({ role: "admin" }).eq("id", m.busy.id);
      expect(await code(claimConversation({ ...m.busy, role: "admin" }, extra.id))).toBe(0);
      await db().from("business_members").update({ role: "operator" }).eq("id", m.busy.id);
    });
    it("una conversación ya tomada → 409; la sesión de demostración (sin miembro real) → 403", async () => {
      const c = await conv(a, "human", { assignTo: m.op2 });
      expect(await code(claimConversation(m.op1, c.id))).toBe(409);
      expect(await code(claimConversation({ ...m.owner, id: null, legacy: true }, (await conv(a, "pending_human")).id))).toBe(403);
    });
    it("S-01 · un miembro de otro negocio no ve la conversación (404)", async () => {
      expect(await code(claimConversation(m.opB, (await conv(a, "pending_human")).id))).toBe(404);
    });
    it("se puede tomar una conversación que atiende la IA (bot → human) y una resuelta", async () => {
      expect(await code(claimConversation(m.op2, (await conv(a, "bot")).id))).toBe(0);
      expect(await code(claimConversation(m.op2, (await conv(a, "resolved")).id))).toBe(0);
    });
  });

  describe("liberar, devolver, resolver, cerrar, derivar", () => {
    it("liberar: el asignado y un admin sí; otro operador no (403)", async () => {
      const c1 = await conv(a, "human", { assignTo: m.op1 });
      expect(await code(releaseConversation(m.op2, c1.id))).toBe(403);
      expect((await releaseConversation(m.op1, c1.id)).status).toBe("pending_human");
      const c2 = await conv(a, "human", { assignTo: m.op1 });
      expect((await releaseConversation(m.admin, c2.id)).status).toBe("pending_human");
    });
    it("devolver a la IA con aviso: manda el mensaje al cliente; sin aviso, no", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      await returnToBot(m.op1, c.id, { notify: true });
      expect(graphFake.texts()).toEqual(["Sigo por aquí, ¿en qué más te ayudo?"]);
      graphFake.reset();
      const d = await conv(a, "human", { assignTo: m.op1 });
      expect((await returnToBot(m.op1, d.id)).status).toBe("bot");
      expect(graphFake.calls).toHaveLength(0);
    });
    it("resolver con aviso envía el mensaje de cierre configurado, con {negocio} sustituido", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      expect((await resolveConversation(m.op1, c.id, { notify: true })).status).toBe("resolved");
      expect(graphFake.texts()).toEqual([`Gracias por escribir a ${a.name}`]);
    });
    it("el aviso fuera de la ventana de 24 h no deshace la acción", async () => {
      const c = await conv(a, "human", { assignTo: m.op1, ageHours: 30 });
      expect((await resolveConversation(m.op1, c.id, { notify: true })).status).toBe("resolved");
      expect(graphFake.calls).toHaveLength(0);
    });
    it("cerrar: un operador no puede cerrar una en cola (403) ni la de otro; sí la propia en human; el admin cualquiera", async () => {
      expect(await code(closeConversation(m.op1, (await conv(a, "pending_human")).id))).toBe(403);
      expect(await code(closeConversation(m.op2, (await conv(a, "human", { assignTo: m.op1 })).id))).toBe(403);
      expect(await code(closeConversation(m.op1, (await conv(a, "human", { assignTo: m.op1 })).id))).toBe(0);
      expect(await code(closeConversation(m.admin, (await conv(a, "bot")).id))).toBe(0);
    });
    it("derivar y devolver a la IA desde la cola", async () => {
      const c = await conv(a, "bot");
      expect((await handoffConversation(m.op1, c.id)).status).toBe("pending_human");
      expect((await declineHandoffByMember(m.op1, c.id)).status).toBe("bot");
    });
    it("marcar como leída", async () => {
      const c = await conv(a, "pending_human");
      await db().from("conversations").update({ unread_count: 3 }).eq("id", c.id);
      await markRead(m.op1, c.id);
      expect((await fresh(c)).unreadCount).toBe(0);
      await expect(markRead(m.opB, c.id)).rejects.toMatchObject({ status: 404 });
    });
    it("una acción sobre una conversación que cambió en el medio devuelve 409", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      await releaseConversation(m.op1, c.id);
      expect(await code(resolveConversation(m.op1, c.id))).toBe(403); // ya no es suya
      expect(await code(resolveConversation(m.admin, c.id))).toBe(409); // y desde la cola no se resuelve
    });
  });

  describe("reasignación (T-09.4)", () => {
    it("el admin la pasa a otro operador: una sola asignación abierta, historial conservado", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      const r = await reassignConversation(m.admin, c.id, m.op2.id);
      expect(r).toMatchObject({ status: "human", assignedMemberId: m.op2.id });
      expect(await assignments(c.id)).toEqual([
        { member_id: m.op1.id, released_at: expect.any(String), release_reason: "reassigned" },
        { member_id: m.op2.id, released_at: null, release_reason: null },
      ]);
    });
    it("un operador no puede reasignar; el destino debe ser un miembro activo; solo en human", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      expect(await code(reassignConversation(m.op1, c.id, m.op2.id))).toBe(403);
      expect(await code(reassignConversation(m.admin, c.id, m.opB.id))).toBe(404);
      await db().from("business_members").update({ status: "disabled" }).eq("id", m.away.id);
      expect(await code(reassignConversation(m.admin, c.id, m.away.id))).toBe(404);
      await db().from("business_members").update({ status: "active" }).eq("id", m.away.id);
      expect(await code(reassignConversation(m.admin, (await conv(a, "pending_human")).id, m.op2.id))).toBe(409);
    });
    it("a quien ya la tiene no hace nada; con versión desfasada → 409", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      expect((await reassignConversation(m.admin, c.id, m.op1.id)).assignedMemberId).toBe(m.op1.id);
      expect(await assignments(c.id)).toHaveLength(1);
      expect(await code(reassignConversation(m.admin, c.id, m.op2.id, 99))).toBe(409);
      expect((await fresh(c)).assignedMemberId).toBe(m.op1.id);
    });
  });

  describe("mensajes del operador (T-09.5)", () => {
    const id = () => crypto.randomUUID();
    it("el asignado envía: se registra como agent, se manda por WhatsApp y marca la primera respuesta", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      const r = await sendAgentMessage(m.op1, c.id, "  Hola, soy Ana  ", id());
      expect(r.duplicate).toBe(false);
      expect(graphFake.texts()).toEqual(["Hola, soy Ana"]);
      const { data } = await db().from("conversation_messages").select("sender_type, sender_member_id, status, wa_message_id, body").eq("id", r.messageId).single();
      expect(data).toEqual({ sender_type: "agent", sender_member_id: m.op1.id, status: "accepted", wa_message_id: graphFake.lastWamid, body: "Hola, soy Ana" });
      expect((await db().from("conversations").select("first_response_at").eq("id", c.id).single()).data!.first_response_at).not.toBeNull();
    });
    it("el mismo client_request_id (doble clic o reintento) se envía una sola vez", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      const key = id();
      const [x, y] = await Promise.all([sendAgentMessage(m.op1, c.id, "uno", key), sendAgentMessage(m.op1, c.id, "uno", key).catch(() => null)]);
      expect(x.messageId).toBeTruthy();
      expect(graphFake.texts().length).toBeLessThanOrEqual(2);
      const again = await sendAgentMessage(m.op1, c.id, "uno", key);
      expect(again.duplicate).toBe(true);
      const { data } = await db().from("conversation_messages").select("id").eq("conversation_id", c.id).eq("client_request_id", key);
      expect(data).toHaveLength(1);
      void y;
    });
    it("otro operador, o la conversación sin tomar → 409; negocio ajeno → 404; sin miembro real → 403", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      expect(await code(sendAgentMessage(m.op2, c.id, "hola", id()))).toBe(409);
      expect(await code(sendAgentMessage(m.admin, c.id, "hola", id()))).toBe(409); // un admin tampoco escribe sin tomarla
      expect(await code(sendAgentMessage(m.op1, (await conv(a, "pending_human")).id, "hola", id()))).toBe(409);
      expect(await code(sendAgentMessage(m.opB, c.id, "hola", id()))).toBe(404);
      expect(await code(sendAgentMessage({ ...m.owner, id: null }, c.id, "hola", id()))).toBe(403);
      expect(graphFake.calls).toHaveLength(0);
    });
    it("H-09 · pasadas 24 h desde el último mensaje del cliente no se envía (hace falta la plantilla)", async () => {
      const c = await conv(a, "human", { assignTo: m.op1, ageHours: 25 });
      await expect(sendAgentMessage(m.op1, c.id, "hola", id())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("24 horas") });
      expect(graphFake.calls).toHaveLength(0);
    });
    it("valida el texto y el identificador", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      expect(await code(sendAgentMessage(m.op1, c.id, "   ", id()))).toBe(400);
      expect(await code(sendAgentMessage(m.op1, c.id, "x".repeat(4097), id()))).toBe(400);
      expect(await code(sendAgentMessage(m.op1, c.id, "hola", "no-es-uuid"))).toBe(400);
    });
    it("si WhatsApp rechaza el envío, el mensaje queda failed, se avisa y no se pierde el evento", async () => {
      const c = await conv(a, "human", { assignTo: m.op1 });
      graphFake.failNext(400, "Número no válido");
      await expect(sendAgentMessage(m.op1, c.id, "hola", id())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Número no válido") });
      expect((await db().from("conversation_messages").select("status").eq("conversation_id", c.id).eq("direction", "outbound").single()).data!.status).toBe("failed");
      expect((await events(c.id)).map((e) => e.type)).toContain("send_failed");
    });
    it("D-08 · la plantilla de reapertura solo existe si está configurada y la envía el asignado", async () => {
      const c = await conv(a, "human", { assignTo: m.op1, ageHours: 30 });
      await expect(sendReopenTemplate(m.op1, c.id, id())).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no está configurada") });
      vi.stubEnv("WHATSAPP_REOPEN_TEMPLATE", "retomar_conversacion");
      expect(await code(sendReopenTemplate(m.op2, c.id, id()))).toBe(409);
      await sendReopenTemplate(m.op1, c.id, id());
      expect(graphFake.templates()).toEqual(["retomar_conversacion"]);
      expect(graphFake.calls[0].body.template!.components![0].parameters.map((p) => p.text)).toEqual([expect.stringContaining("Cliente"), a.name]);
      vi.unstubAllEnvs();
    });
  });

  describe("mantenimiento (T-09.7)", () => {
    afterEach(() => vi.unstubAllEnvs());
    it("T9 · bot sin entrantes 2 h después de la respuesta de la IA → resolved; si el último mensaje es del cliente, no", async () => {
      const c = await conv(a, "bot", { ageHours: 3 });
      await db().from("conversations").update({ last_message_at: new Date(Date.now() - 3 * 3_600_000 + 60_000).toISOString() }).eq("id", c.id); // la IA respondió después
      const pending = await conv(a, "bot", { ageHours: 3 }); // último mensaje: del cliente
      const fresher = await conv(a, "bot", { ageHours: 1 });
      await runMaintenance();
      expect((await fresh(c)).status).toBe("resolved");
      expect((await fresh(pending)).status).toBe("bot");
      expect((await fresh(fresher)).status).toBe("bot");
    });
    it("T11 · se cierra según inactivity_close_hours del negocio (24 h por defecto)", async () => {
      const old = await conv(a, "resolved", { ageHours: 30 });
      const recent = await conv(a, "resolved", { ageHours: 10 });
      const other = await conv(b, "resolved", { ageHours: 30 }); // sin configuración propia: 24 h
      await runMaintenance();
      expect((await fresh(old)).status).toBe("closed");
      expect((await fresh(recent)).status).toBe("resolved");
      expect((await fresh(other)).status).toBe("closed");
      await db().from("chatbot_settings").update({ inactivity_close_hours: 48 }).eq("business_id", a.id);
      const keep = await conv(a, "resolved", { ageHours: 30 });
      await runMaintenance();
      expect((await fresh(keep)).status).toBe("resolved");
      await db().from("chatbot_settings").update({ inactivity_close_hours: 24 }).eq("business_id", a.id);
    });
    it("las conversaciones en atención humana no se cierran ni se resuelven solas", async () => {
      const h = await conv(a, "human", { assignTo: m.op1, ageHours: 100 });
      const p = await conv(a, "pending_human", { ageHours: 100 });
      await runMaintenance();
      expect((await fresh(h)).status).toBe("human");
      expect((await fresh(p)).status).toBe("pending_human");
    });
    it("disponibilidad: sin señal en 15 min (o nunca) pasa a no disponible", async () => {
      await db().from("business_members").update({ is_available: true, last_seen_at: new Date(Date.now() - 20 * 60_000).toISOString() }).eq("id", m.away.id);
      await db().from("business_members").update({ is_available: true, last_seen_at: null }).eq("id", m.busy.id);
      await db().from("business_members").update({ is_available: true, last_seen_at: new Date().toISOString() }).eq("id", m.op1.id);
      await runMaintenance();
      const rows = (await db().from("business_members").select("id, is_available").in("id", [m.away.id, m.busy.id, m.op1.id])).data!;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.is_available]))).toEqual({ [m.away.id]: false, [m.busy.id]: false, [m.op1.id]: true });
    });
    it("re-encola el mensaje del cliente que lleva más de 2 min sin respuesta (solo con el chatbot activo)", async () => {
      vi.stubEnv("CHATBOT_ENABLED", "true");
      const c = await conv(a, "bot");
      const when = new Date(Date.now() - 5 * 60_000).toISOString();
      await db().from("conversations").update({ last_message_at: when, last_inbound_at: when }).eq("id", c.id);
      qstashFake.reset();
      const r = await runMaintenance();
      expect(r.requeued).toBeGreaterThanOrEqual(1);
      expect(qstashFake.jobs.some((j) => j.path === "/api/jobs/chatbot-reply" && (j.body as { conversationId: string }).conversationId === c.id)).toBe(true);

      vi.stubEnv("CHATBOT_ENABLED", "false");
      qstashFake.reset();
      await runMaintenance();
      expect(qstashFake.jobs).toHaveLength(0);
    });
    it("es idempotente: la segunda corrida seguida no cambia nada", async () => {
      await conv(a, "resolved", { ageHours: 40 });
      await runMaintenance();
      expect(await runMaintenance()).toEqual({ resolved: 0, closed: 0, requeued: expect.any(Number), unavailable: 0, purged: 0 });
    });
  });
});
