/**
 * Panel (Fase 10) contra la base de desarrollo: aislamiento entre negocios (S-01), bandeja con filtros y cursor,
 * detalle, métricas contra consultas de control, contadores de navegación, equipo y preguntas sin respuesta.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMinRole } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { groupQuestions, significantTokens } from "@/lib/chatbot/unanswered";
import { getConversationDetail, getInboxCounts, getMetrics, listInbox, median, PAGE_SIZE } from "@/lib/chatbot/panel-data";
import { getAgenda, getAppointmentDetail, getBusinesses, getRecentActivity, getStats } from "@/lib/panel/data";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, insertAppointment, RUN_ID, testPhone, type TestBusiness } from "../helpers/supabase-test";
import { inDays } from "../helpers/regression";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
type TM = Member & { id: string };
const state: { member: Member | null } = { member: null };
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  requireMember: async (min: Member["role"]) => {
    if (!state.member) throw new Error("NEXT_REDIRECT");
    if (!hasMinRole(state.member.role, min)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return state.member;
  },
  getCurrentMember: async () => state.member,
}));
import { setMyAvailabilityAction, inviteMemberAction, updateMemberAction } from "@/app/panel/equipo/actions";
import { ignoreUnansweredAction, resolveUnansweredWithFaqAction } from "@/app/panel/conocimiento/actions";
import { setStatusAction } from "@/app/panel/actions";
import { GET as inboxCounters } from "@/app/api/panel/inbox/route";
import { claimConversationAction, closeConversationAction, reassignConversationAction, sendAgentMessageAction } from "@/app/panel/conversaciones/actions";
import { GET as messagesGet } from "@/app/api/panel/conversations/[id]/messages/route";

describe("agrupación de preguntas sin respuesta (unitaria)", () => {
  it("palabras significativas: sin tildes, signos, palabras vacías ni plurales simples", () => {
    expect(significantTokens("¿Cuál es el horario de los sábados?")).toEqual(["horario", "sabado"]);
    expect(significantTokens("Horarios sábado")).toEqual(["horario", "sabado"]);
  });
  const row = (id: string, question: string, at: string, reason = "no_context") => ({ id, question, reason, created_at: at });
  it("agrupa las preguntas parecidas y ordena por cantidad", () => {
    const groups = groupQuestions([
      row("1", "¿Aceptan tarjeta de crédito?", "2026-11-01T10:00:00Z"),
      row("2", "aceptan tarjetas de credito", "2026-11-02T10:00:00Z", "low_confidence"),
      row("3", "¿Tienen estacionamiento?", "2026-11-03T10:00:00Z"),
      row("4", "Aceptan tarjeta de crédito?", "2026-11-04T10:00:00Z"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ count: 3, ids: ["4", "2", "1"], question: "Aceptan tarjeta de crédito?", reasons: ["no_context", "low_confidence"] });
    expect(groups[1]).toMatchObject({ count: 1, question: "¿Tienen estacionamiento?" });
  });
  it("preguntas sin palabras significativas no se mezclan entre sí", () => {
    expect(groupQuestions([row("1", "¿?", "2026-11-01T10:00:00Z"), row("2", "???", "2026-11-02T10:00:00Z")])).toHaveLength(2);
  });
  it("mediana", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 9, 3])).toBe(3);
    expect(median([1, 2, 3, 10])).toBe(3);
  });
});

describe.skipIf(!hasDb)("panel", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  const m: Record<string, TM> = {};
  let counter = 0;

  async function member(biz: TestBusiness, key: string, role: Member["role"], extra: Record<string, unknown> = {}): Promise<TM> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `${key}-${RUN_ID}@example.test`, display_name: key, role, status: "active", is_available: true, max_concurrent: 50, ...extra })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role, displayName: key, legacy: false };
  }
  async function conv(biz: TestBusiness, o: { status?: string; name?: string; phone?: string; body?: string; minutesAgo?: number; assignTo?: TM; handoff?: boolean; reason?: string } = {}) {
    const phone = o.phone ?? testPhone();
    const { data: contact } = await db().from("chat_contacts").insert({ business_id: biz.id, channel: "whatsapp", external_id: phone, display_name: o.name ?? `Cliente ${++counter}` }).select("id").single();
    const at = new Date(Date.now() - (o.minutesAgo ?? 0) * 60_000).toISOString();
    const status = o.status ?? "bot";
    const row: Record<string, unknown> = { business_id: biz.id, contact_id: contact!.id, channel: "whatsapp", status, last_message_at: at, last_inbound_at: at, created_at: at, handoff_reason: o.reason ?? null, handoff_requested_at: o.handoff ? at : null };
    if (status === "human") Object.assign(row, { assigned_member_id: o.assignTo!.id, assigned_at: at });
    const { data: c, error } = await db().from("conversations").insert(row).select("id").single();
    if (error) throw error;
    await db().from("conversation_messages").insert({ conversation_id: c!.id, business_id: biz.id, direction: "inbound", sender_type: "customer", body: o.body ?? "hola", status: "delivered", created_at: at });
    if (status === "human") await db().from("conversation_assignments").insert({ conversation_id: c!.id, business_id: biz.id, member_id: o.assignTo!.id, assigned_at: at });
    return { id: c!.id as string, phone, at };
  }

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    m.owner = await member(a, "owner", "owner");
    m.admin = await member(a, "admin", "admin");
    m.op = await member(a, "op", "operator");
    m.opB = await member(b, "opb", "operator");
    m.adminB = await member(b, "adminb", "admin");
    await db().from("chatbot_settings").insert({ business_id: a.id, llm_model: "fake-1", enabled: true });
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);
  beforeEach(() => {
    state.member = m.admin;
  });

  describe("S-01 · un negocio no ve los datos de otro", () => {
    it("agenda, métricas, actividad y detalle de turnos del panel actual", async () => {
      const phone = testPhone();
      const apptId = await insertAppointment({ businessId: a.id, phone, startsAt: inDays(2) });
      await db().from("messages").insert({ business_id: a.id, appointment_id: apptId, to_phone: phone, kind: "reminder_24h", template_name: "x", status: "failed", failed_at: new Date().toISOString(), error: { message: "x" } });
      const { data: inbound } = await db().from("inbound_messages").insert({ wa_message_id: `wamid.TEST.IN.${RUN_ID}.S01`, from_phone: phone, type: "text", body: "1", appointment_id: apptId, received_at: new Date().toISOString(), payload: {} }).select("id").single();

      expect((await getAgenda("upcoming", a.id)).map((x) => x.id)).toContain(apptId);
      expect((await getAgenda("upcoming", b.id)).map((x) => x.id)).not.toContain(apptId);
      expect((await getBusinesses(b.id)).map((x) => x.id)).toEqual([b.id]);
      expect((await getAppointmentDetail(apptId, a.id))?.id).toBe(apptId);
      expect(await getAppointmentDetail(apptId, b.id)).toBeNull();
      expect((await getRecentActivity(a.id)).length).toBeGreaterThanOrEqual(2);
      expect(await getRecentActivity(b.id)).toEqual([]);
      expect((await getStats(a.timezone, a.id)).next7Days).toBeGreaterThanOrEqual(1);
      expect((await getStats(b.timezone, b.id)).next7Days).toBe(0);
      await db().from("inbound_messages").delete().eq("id", inbound!.id);
    });
    it("las acciones sobre un turno de otro negocio responden «Turno inválido» y no cambian nada", async () => {
      const apptId = await insertAppointment({ businessId: a.id, phone: testPhone(), startsAt: inDays(2) });
      state.member = m.adminB;
      expect(await setStatusAction(apptId, "cancelled", false)).toEqual({ ok: false, error: "Turno inválido" });
      expect((await db().from("appointments").select("status").eq("id", apptId).single()).data!.status).toBe("scheduled");
      state.member = m.admin;
      expect(await setStatusAction(apptId, "confirmed", false)).toMatchObject({ ok: true });
    });
    it("conversaciones: bandeja, detalle, contadores y acciones", async () => {
      const c = await conv(a, { status: "pending_human", body: "secreto de A" });
      expect((await listInbox(a.id, m.admin, { tab: "all" })).items.map((i) => i.id)).toContain(c.id);
      expect((await listInbox(b.id, m.adminB, { tab: "all" })).items).toEqual([]);
      expect(await getConversationDetail(b.id, c.id)).toBeNull();
      expect((await getInboxCounts(b.id, m.adminB)).all).toBe(0);
      state.member = m.opB;
      expect(await claimConversationAction(c.id)).toEqual({ ok: false, error: "La conversación no existe" });
      state.member = m.adminB;
      expect(await closeConversationAction(c.id)).toMatchObject({ ok: false });
      expect(await reassignConversationAction(c.id, m.opB.id)).toMatchObject({ ok: false });
      expect(await sendAgentMessageAction(c.id, "hola", crypto.randomUUID())).toMatchObject({ ok: false });
      const res = await messagesGet(new Request("http://localhost/x"), { params: Promise.resolve({ id: c.id }) } as never);
      expect(res.status).toBe(404);
      expect((await db().from("conversations").select("status").eq("id", c.id).single()).data!.status).toBe("pending_human");
    });
  });

  describe("bandeja", () => {
    it("pestañas: pendientes, mías, IA, todas y cerradas; con contadores coherentes", async () => {
      const fresh = await createTestBusiness();
      try {
        const op = await member(fresh, "op", "operator");
        const other = await member(fresh, "other", "operator");
        await conv(fresh, { status: "pending_human", handoff: true, reason: "customer_request" });
        await conv(fresh, { status: "human", assignTo: op });
        await conv(fresh, { status: "human", assignTo: other });
        await conv(fresh, { status: "bot" });
        await conv(fresh, { status: "bot" });
        await conv(fresh, { status: "resolved" });
        await conv(fresh, { status: "closed" });
        const ids = async (tab: Parameters<typeof listInbox>[2]["tab"]) => (await listInbox(fresh.id, op, { tab })).items;
        expect((await ids("pending")).map((i) => i.status)).toEqual(["pending_human"]);
        expect((await ids("pending"))[0].handoffReason).toBe("customer_request");
        expect((await ids("mine")).map((i) => i.assignedTo?.name)).toEqual(["op"]);
        expect((await ids("ai"))).toHaveLength(2);
        expect((await ids("all"))).toHaveLength(6);
        expect((await ids("closed")).map((i) => i.status)).toEqual(["closed"]);
        expect(await getInboxCounts(fresh.id, op)).toEqual({ pending: 1, mine: 1, ai: 2, all: 6, closed: 1 });
        expect((await listInbox(fresh.id, { id: null }, { tab: "mine" })).items).toEqual([]);
      } finally {
        await cleanup(fresh.id);
      }
    });
    it("búsqueda por nombre, teléfono y texto del mensaje; filtros por canal, operador y fecha", async () => {
      const fresh = await createTestBusiness();
      try {
        const op = await member(fresh, "op", "operator");
        const x = await conv(fresh, { name: "María Pérez", body: "quiero un turno para el jueves", phone: "59891110001" });
        await conv(fresh, { name: "Juan Gómez", body: "¿tienen estacionamiento?", phone: "59892220002", status: "human", assignTo: op, minutesAgo: 60 * 24 * 5 });
        const find = async (f: Partial<Parameters<typeof listInbox>[2]>) => (await listInbox(fresh.id, op, { tab: "all", ...f })).items.map((i) => i.contactName);
        expect(await find({ q: "maría" })).toEqual(["María Pérez"]);
        expect(await find({ q: "2220002" })).toEqual(["Juan Gómez"]);
        expect(await find({ q: "estacionamiento" })).toEqual(["Juan Gómez"]);
        expect(await find({ q: "jueves" })).toEqual(["María Pérez"]);
        expect(await find({ q: "nada de esto" })).toEqual([]);
        expect(await find({ q: "100%_(x),*" })).toEqual([]); // caracteres especiales no rompen la consulta
        expect(await find({ channel: "web" })).toEqual([]);
        expect(await find({ channel: "whatsapp" })).toHaveLength(2);
        expect(await find({ operatorId: op.id })).toEqual(["Juan Gómez"]);
        // Los filtros de fecha se interpretan en la zona horaria del negocio (Montevideo), no en UTC: la prueba
        // calcula los días igual, o fallaba entre las 21:00 y las 24:00 locales (ya es «mañana» en UTC).
        const dayInBusinessZone = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/Montevideo" });
        expect(await find({ from: dayInBusinessZone(Date.now()) })).toEqual(["María Pérez"]);
        expect(await find({ to: dayInBusinessZone(Date.now() - 2 * 86_400_000) })).toEqual(["Juan Gómez"]);
        expect(x.id).toBeTruthy();
      } finally {
        await cleanup(fresh.id);
      }
    });
    it("paginación por cursor: sin repetir ni saltar conversaciones, del más reciente al más antiguo", async () => {
      const fresh = await createTestBusiness();
      try {
        const op = await member(fresh, "op", "operator");
        const total = PAGE_SIZE + 12;
        const created: string[] = [];
        for (let i = 0; i < total; i++) created.push((await conv(fresh, { minutesAgo: i, name: `C${i}` })).id);
        const p1 = await listInbox(fresh.id, op, { tab: "all" });
        expect(p1.items).toHaveLength(PAGE_SIZE);
        expect(p1.nextCursor).not.toBeNull();
        const p2 = await listInbox(fresh.id, op, { tab: "all", cursor: p1.nextCursor! });
        expect(p2.items).toHaveLength(12);
        expect(p2.nextCursor).toBeNull();
        expect([...p1.items, ...p2.items].map((i) => i.id)).toEqual(created);
        expect((await listInbox(fresh.id, op, { tab: "all", cursor: "basura|no-uuid" })).items).toHaveLength(PAGE_SIZE); // cursor inválido se ignora
      } finally {
        await cleanup(fresh.id);
      }
    }, 120_000);
    it("la vista previa muestra el último mensaje y quién lo escribió", async () => {
      const c = await conv(a, { body: "primero" });
      await db().from("conversation_messages").insert({ conversation_id: c.id, business_id: a.id, direction: "outbound", sender_type: "bot", body: "respuesta del asistente", status: "accepted", created_at: new Date(Date.now() + 1000).toISOString() });
      const item = (await listInbox(a.id, m.admin, { tab: "all", q: "primero" })).items.find((i) => i.id === c.id)!;
      expect(item).toMatchObject({ preview: "respuesta del asistente", previewFrom: "bot" });
    });
  });

  describe("detalle de conversación (H-04)", () => {
    it("historial completo y ordenado: mensajes, eventos y recordatorios, con el motivo y la ventana de 24 h", async () => {
      const phone = testPhone();
      const c = await conv(a, { status: "pending_human", phone, body: "quiero hablar con alguien", handoff: true, reason: "no_information" });
      await db().from("conversations").update({ summary: "Quiere hablar con una persona", handoff_requested_at: new Date().toISOString() }).eq("id", c.id);
      await db().from("conversation_messages").insert({ conversation_id: c.id, business_id: a.id, direction: "outbound", sender_type: "bot", body: "Te paso con el equipo", status: "read", ai: { used_source_ids: ["c1"] }, created_at: new Date(Date.now() + 1000).toISOString() });
      await db().from("conversation_events").insert({ conversation_id: c.id, business_id: a.id, type: "handoff_accepted", actor_type: "customer", from_status: "bot", to_status: "pending_human", created_at: new Date(Date.now() + 2000).toISOString() });
      const apptId = await insertAppointment({ businessId: a.id, phone, startsAt: inDays(2) });
      await db().from("messages").insert({ business_id: a.id, appointment_id: apptId, to_phone: phone, kind: "reminder_24h", template_name: "x", status: "read", sent_at: new Date(Date.now() - 3600_000).toISOString() });

      const d = (await getConversationDetail(a.id, c.id))!;
      expect(d.conversation).toMatchObject({ status: "pending_human", handoffReason: "no_information", summary: "Quiere hablar con una persona" });
      expect(d.timeline.map((e) => e.kind)).toEqual(["reminder", "message", "message", "event"]);
      expect(d.timeline[2]).toMatchObject({ kind: "message", sender: "bot", sources: ["c1"], status: "read" });
      expect(d.timeline.map((e) => e.at)).toEqual([...d.timeline.map((e) => e.at)].sort());
      expect(d.contact).toMatchObject({ phone });
      expect(d.contact.customerId).toBeNull(); // el contacto de la prueba no se enlazó
      expect(d.windowClosesAt).not.toBeNull();
      expect(new Date(d.windowClosesAt!).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    });
    it("con la ventana vencida no hay hora de cierre; muestra el próximo turno del cliente y sus preguntas sin respuesta", async () => {
      const phone = testPhone();
      const apptId = await insertAppointment({ businessId: a.id, phone, startsAt: inDays(3) });
      const customer = (await db().from("customers").select("id").eq("business_id", a.id).eq("phone", phone).single()).data!;
      const c = await conv(a, { phone, minutesAgo: 60 * 30 });
      await db().from("chat_contacts").update({ customer_id: customer.id }).eq("business_id", a.id).eq("external_id", phone);
      await db().from("unanswered_questions").insert({ business_id: a.id, conversation_id: c.id, question: "¿Hacen tintes?", reason: "no_context" });
      const d = (await getConversationDetail(a.id, c.id))!;
      expect(d.windowClosesAt).toBeNull();
      expect(d.nextAppointment).toMatchObject({ id: apptId });
      expect(d.unanswered).toEqual([expect.objectContaining({ question: "¿Hacen tintes?", status: "open" })]);
    });
  });

  describe("navegación y disponibilidad (T-10.2)", () => {
    it("contadores: pendientes del negocio, mis conversaciones y no leídos; marca last_seen_at", async () => {
      const fresh = await createTestBusiness();
      try {
        const op = await member(fresh, "op", "operator", { last_seen_at: null, is_available: false });
        await conv(fresh, { status: "pending_human" });
        await conv(fresh, { status: "pending_human" });
        const mine = await conv(fresh, { status: "human", assignTo: op });
        await db().from("conversations").update({ unread_count: 3 }).eq("id", mine.id);
        state.member = op;
        const res = await inboxCounters();
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.json()).toEqual({ pending: 2, mine: 1, mineUnread: 3, available: false });
        expect((await db().from("business_members").select("last_seen_at").eq("id", op.id).single()).data!.last_seen_at).not.toBeNull();
      } finally {
        await cleanup(fresh.id);
      }
    });
    it("sin sesión → 401; la sesión de demostración ve contadores pero no tiene disponibilidad", async () => {
      state.member = null;
      expect((await inboxCounters()).status).toBe(401);
      state.member = { id: null, userId: null, businessId: a.id, role: "owner", displayName: "Demo", legacy: true };
      expect(await (await inboxCounters()).json()).toMatchObject({ available: null, mine: 0 });
    });
    it("cada miembro cambia su propia disponibilidad", async () => {
      state.member = m.op;
      expect(await setMyAvailabilityAction(false)).toMatchObject({ ok: true });
      expect((await db().from("business_members").select("is_available").eq("id", m.op.id).single()).data!.is_available).toBe(false);
      expect(await setMyAvailabilityAction(true)).toMatchObject({ ok: true });
      state.member = { ...m.op, id: null as never, legacy: true };
      expect(await setMyAvailabilityAction(true)).toMatchObject({ ok: false });
    });
  });

  describe("métricas (T-10.5): coinciden con las consultas de control", () => {
    it("valores sobre datos sembrados", async () => {
      const fresh = await createTestBusiness();
      try {
        const op = await member(fresh, "op", "operator");
        // 10 conversaciones de los últimos 7 días: 4 resueltas por la IA, 3 derivadas (2 atendidas), 3 siguen con la IA.
        const ids: Record<string, string> = {};
        const mk = async (key: string, o: Parameters<typeof conv>[1]) => (ids[key] = (await conv(fresh, o)).id);
        for (const k of ["r1", "r2", "r3"]) await mk(k, { status: "resolved", minutesAgo: 120 });
        await mk("c1", { status: "closed", minutesAgo: 90 });
        await mk("h1", { status: "human", assignTo: op, handoff: true, minutesAgo: 60 });
        await mk("h2", { status: "resolved", handoff: true, minutesAgo: 50 });
        await mk("h3", { status: "pending_human", handoff: true, minutesAgo: 40 });
        for (const k of ["b1", "b2", "b3"]) await mk(k, { status: "bot", minutesAgo: 30 });
        await mk("old", { status: "resolved", minutesAgo: 60 * 24 * 10 }); // fuera de los 7 días
        const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
        const msg = (conv: string, sender: string, direction: string, when: string) => db().from("conversation_messages").insert({ conversation_id: conv, business_id: fresh.id, direction, sender_type: sender, body: "x", status: "delivered", created_at: when });
        // Primera respuesta de la IA: 20 s, 40 s y 120 s → mediana 40 s (los mensajes del cliente ya están sembrados por `conv`).
        await db().from("conversation_messages").delete().in("conversation_id", Object.values(ids));
        for (const [k, sec, base] of [["r1", 20, 120], ["r2", 40, 120], ["b1", 120, 30]] as const) {
          await msg(ids[k], "customer", "inbound", at(base));
          await msg(ids[k], "bot", "outbound", new Date(Date.now() - base * 60_000 + sec * 1000).toISOString());
        }
        // Primera respuesta humana: h1 a los 5 min de la derivación, h2 a los 15 min → mediana 10 min.
        for (const [k, min, base] of [["h1", 5, 60], ["h2", 15, 50]] as const) {
          await msg(ids[k], "customer", "inbound", at(base));
          await msg(ids[k], "agent", "outbound", new Date(Date.now() - base * 60_000 + min * 60_000).toISOString());
        }
        await db().from("unanswered_questions").insert([
          { business_id: fresh.id, question: "a", reason: "no_context", status: "open" }, { business_id: fresh.id, question: "b", reason: "no_context", status: "open" },
          { business_id: fresh.id, question: "c", reason: "no_context", status: "ignored" },
        ]);

        const metrics = await getMetrics(fresh.id, 7, fresh.timezone, false);
        expect(metrics).toMatchObject({
          days: 7, conversations: 10, resolvedByAiPct: 40, handedOffPct: 30, pendingNow: 1, unansweredOpen: 2,
          firstAiResponseSec: 40, costs: null,
        });
        // La derivación se sembró unos segundos antes que el mensaje: la mediana es de ~10 min.
        expect(metrics.firstHumanResponseSec).toBeGreaterThanOrEqual(595);
        expect(metrics.firstHumanResponseSec).toBeLessThanOrEqual(660);
        expect(metrics.daily).toHaveLength(7);
        expect(metrics.daily.reduce((s, d) => s + d.ai + d.handedOff, 0)).toBe(10);
        expect(metrics.daily.reduce((s, d) => s + d.handedOff, 0)).toBe(3);
        // 30 días incluye la conversación vieja.
        const m30 = await getMetrics(fresh.id, 30, fresh.timezone, false);
        expect(m30.conversations).toBe(11);
        expect(m30.resolvedByAiPct).toBe(Math.round((5 / 11) * 100));
        // Consulta de control directa a la base.
        const { count } = await db().from("conversations").select("id", { count: "exact", head: true }).eq("business_id", fresh.id).gte("created_at", at(60 * 24 * 7));
        expect(count).toBe(metrics.conversations);
      } finally {
        await cleanup(fresh.id);
      }
    });
    it("costos solo para quien puede verlos; coinciden con la suma de chatbot_usage", async () => {
      const fresh = await createTestBusiness();
      try {
        await db().from("chatbot_settings").insert({ business_id: fresh.id, monthly_budget_usd: 5 });
        await db().from("chatbot_usage").insert([
          { business_id: fresh.id, operation: "chat", provider: "gemini", model: "gemini-3.5-flash-lite", input_tokens: 1000, cache_read_tokens: 0, output_tokens: 200, cost_usd: 0.0008 },
          { business_id: fresh.id, operation: "chat", provider: "gemini", model: "gemini-3.5-flash-lite", input_tokens: 500, cache_read_tokens: 100, output_tokens: 100, cost_usd: 0.0004 },
          { business_id: fresh.id, operation: "embedding_query", provider: "voyage", model: "voyage-4-lite", input_tokens: 30, cache_read_tokens: 0, output_tokens: 0, cost_usd: 0.000001 },
        ]);
        expect((await getMetrics(fresh.id, 7, fresh.timezone, false)).costs).toBeNull();
        const costs = (await getMetrics(fresh.id, 7, fresh.timezone, true)).costs!;
        expect(costs.monthlyBudgetUsd).toBe(5);
        expect(costs.monthCostUsd).toBeCloseTo(0.001201, 6);
        expect(costs.byOperation).toEqual([
          { operation: "chat", model: "gemini-3.5-flash-lite", calls: 2, inputTokens: 1600, outputTokens: 300, costUsd: expect.closeTo(0.0012, 6) },
          { operation: "embedding_query", model: "voyage-4-lite", calls: 1, inputTokens: 30, outputTokens: 0, costUsd: expect.closeTo(0.000001, 8) },
        ]);
      } finally {
        await cleanup(fresh.id);
      }
    });
  });

  describe("equipo (T-10.6)", () => {
    it("el admin invita a un operador pero no a un owner; un operador no puede invitar; el último owner no se desactiva", async () => {
      vi.spyOn((await import("@/lib/supabase/admin")).getSupabaseAdmin().auth.admin, "inviteUserByEmail").mockImplementation((async () => ({ data: {}, error: null })) as never);
      state.member = m.admin;
      expect(await inviteMemberAction({ email: `nuevo-${RUN_ID}@example.test`, name: "Nuevo", role: "operator" })).toMatchObject({ ok: true });
      expect(await inviteMemberAction({ email: `owner2-${RUN_ID}@example.test`, name: "Otro", role: "owner" })).toMatchObject({ ok: false, error: expect.stringContaining("permiso") });
      expect(await inviteMemberAction({ email: "x@y.com", name: "X", role: "superuser" })).toEqual({ ok: false, error: "Rol inválido" });
      state.member = m.op;
      await expect(inviteMemberAction({ email: `z-${RUN_ID}@example.test`, name: "Z", role: "operator" })).rejects.toThrow("403");
      state.member = m.owner;
      expect(await updateMemberAction(m.owner.id, { status: "disabled" })).toMatchObject({ ok: false, error: expect.stringContaining("al menos un owner") });
      expect(await updateMemberAction(m.op.id, { maxConcurrent: 7 })).toMatchObject({ ok: true });
      expect(await updateMemberAction(m.op.id, { status: "inventado" })).toEqual({ ok: false, error: "Estado inválido" });
      vi.restoreAllMocks();
    });
  });

  describe("preguntas sin respuesta (T-10.7)", () => {
    it("«Crear FAQ» marca todo el grupo como resuelto con resolved_source_id; «Ignorar» las descarta", async () => {
      const mk = async (q: string, biz = a) => (await db().from("unanswered_questions").insert({ business_id: biz.id, question: q, reason: "no_context" }).select("id").single()).data!.id as string;
      const ids = [await mk("¿Aceptan tarjeta de crédito?"), await mk("aceptan tarjetas de credito")];
      state.member = m.admin;
      const r = await resolveUnansweredWithFaqAction({ ids, title: "Medios de pago", question: "¿Aceptan tarjeta?", answer: "Sí, todas las tarjetas." });
      expect(r).toMatchObject({ ok: true, message: expect.stringContaining("2 preguntas resueltas") });
      const rows = (await db().from("unanswered_questions").select("status, resolved_source_id, resolved_by, resolved_at").in("id", ids)).data!;
      expect(rows).toEqual(Array(2).fill({ status: "resolved", resolved_source_id: r.id, resolved_by: m.admin.id, resolved_at: expect.any(String) }));
      expect((await db().from("knowledge_sources").select("type, faq_answer").eq("id", r.id!).single()).data).toEqual({ type: "faq", faq_answer: "Sí, todas las tarjetas." });

      const ignored = await mk("pregunta irrelevante");
      expect(await ignoreUnansweredAction([ignored])).toMatchObject({ ok: true, message: "Pregunta ignorada" });
      expect((await db().from("unanswered_questions").select("status").eq("id", ignored).single()).data!.status).toBe("ignored");
    });
    it("solo toca preguntas abiertas de su negocio y exige permiso", async () => {
      const mine = (await db().from("unanswered_questions").insert({ business_id: a.id, question: "de A", reason: "no_context" }).select("id").single()).data!.id as string;
      state.member = m.adminB;
      expect(await ignoreUnansweredAction([mine])).toMatchObject({ ok: true, message: "0 preguntas ignoradas" });
      expect((await db().from("unanswered_questions").select("status").eq("id", mine).single()).data!.status).toBe("open");
      expect(await ignoreUnansweredAction(["no-es-uuid"])).toMatchObject({ ok: false });
      state.member = m.op;
      await expect(ignoreUnansweredAction([mine])).rejects.toThrow("403");
    });
    it("una FAQ inválida no resuelve nada", async () => {
      const id = (await db().from("unanswered_questions").insert({ business_id: a.id, question: "sin respuesta", reason: "no_context" }).select("id").single()).data!.id as string;
      state.member = m.admin;
      expect(await resolveUnansweredWithFaqAction({ ids: [id], title: "T", question: "q", answer: "  " })).toMatchObject({ ok: false });
      expect((await db().from("unanswered_questions").select("status").eq("id", id).single()).data!.status).toBe("open");
    });
  });
});
