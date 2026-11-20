import "server-only";
import type { Member } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { ConversationStatus } from "./conversations/events";
import { startOfMonth } from "./usage/budget";

/** Consultas de solo lectura para la bandeja, el detalle y las métricas del chatbot. Todas reciben `businessId`. */

const db = () => getSupabaseAdmin();

export type InboxTab = "pending" | "mine" | "ai" | "all" | "closed";
export const INBOX_TABS: InboxTab[] = ["pending", "mine", "ai", "all", "closed"];
export const PAGE_SIZE = 30;

export interface InboxFilters {
  tab: InboxTab;
  q?: string;
  channel?: "whatsapp" | "web";
  operatorId?: string;
  /** YYYY-MM-DD, inclusive (zona horaria del negocio). */
  from?: string;
  to?: string;
  /** `${last_message_at}|${id}` de la última fila de la página anterior. */
  cursor?: string;
}

export interface InboxItem {
  id: string;
  status: ConversationStatus;
  channel: "whatsapp" | "web";
  contactName: string | null;
  phone: string;
  preview: string | null;
  previewFrom: "customer" | "bot" | "agent" | "system" | null;
  handoffReason: string | null;
  unread: number;
  assignedTo: { id: string; name: string } | null;
  lastMessageAt: string;
}

interface ConvRow {
  id: string;
  status: ConversationStatus;
  channel: "whatsapp" | "web";
  handoff_reason: string | null;
  unread_count: number;
  assigned_member_id: string | null;
  last_message_at: string;
  contact: { display_name: string | null; external_id: string } | null;
  assigned: { id: string; display_name: string } | null;
}

/** Texto de búsqueda seguro para un filtro PostgREST (sin separadores ni comodines). */
const safeTerm = (q: string) => q.replace(/[%_\\,()*]/g, " ").trim().slice(0, 80);

/** Página de la bandeja, del mensaje más reciente al más antiguo, con paginación por cursor. */
export async function listInbox(businessId: string, member: Pick<Member, "id">, f: InboxFilters, timeZone = "America/Montevideo") {
  let query = db()
    .from("conversations")
    .select("id, status, channel, handoff_reason, unread_count, assigned_member_id, last_message_at, contact:chat_contacts!inner(display_name, external_id), assigned:business_members!conversations_assigned_member_id_fkey(id, display_name)")
    .eq("business_id", businessId)
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  switch (f.tab) {
    case "pending": query = query.eq("status", "pending_human"); break;
    case "mine": query = member.id ? query.eq("status", "human").eq("assigned_member_id", member.id) : query.eq("id", "00000000-0000-0000-0000-000000000000"); break;
    case "ai": query = query.eq("status", "bot"); break;
    case "closed": query = query.eq("status", "closed"); break;
    default: query = query.neq("status", "closed");
  }
  if (f.channel) query = query.eq("channel", f.channel);
  if (f.operatorId) query = query.eq("assigned_member_id", f.operatorId);
  if (f.from) query = query.gte("last_message_at", `${f.from}T00:00:00${offset(timeZone)}`);
  if (f.to) query = query.lte("last_message_at", `${f.to}T23:59:59${offset(timeZone)}`);

  const term = f.q ? safeTerm(f.q) : "";
  if (term) {
    // Nombre o teléfono del contacto, o texto de algún mensaje de la conversación.
    const [byContact, byMessage] = await Promise.all([
      db().from("chat_contacts").select("id").eq("business_id", businessId).or(`display_name.ilike.%${term}%,external_id.ilike.%${term}%`).limit(200),
      db().from("conversation_messages").select("conversation_id").eq("business_id", businessId).ilike("body", `%${term}%`).limit(200),
    ]);
    const contactIds = (byContact.data ?? []).map((c) => c.id);
    const convIds = [...new Set((byMessage.data ?? []).map((m) => m.conversation_id))];
    const parts = [
      ...(contactIds.length ? [`contact_id.in.(${contactIds.join(",")})`] : []),
      ...(convIds.length ? [`id.in.(${convIds.join(",")})`] : []),
    ];
    if (parts.length === 0) return { items: [] as InboxItem[], nextCursor: null as string | null };
    query = query.or(parts.join(","));
  }

  if (f.cursor) {
    const [ts, id] = f.cursor.split("|");
    if (ts && id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(Date.parse(ts))) {
      query = query.or(`last_message_at.lt.${ts},and(last_message_at.eq.${ts},id.lt.${id})`);
    }
  }

  const { data, error } = await query.returns<ConvRow[]>();
  if (error) throw error;
  const rows = data ?? [];
  const page = rows.slice(0, PAGE_SIZE);

  // Vista previa: el último mensaje de cada conversación de la página.
  const previews = new Map<string, { body: string | null; sender: InboxItem["previewFrom"]; content: string }>();
  if (page.length) {
    const { data: msgs, error: msgError } = await db()
      .from("conversation_messages")
      .select("conversation_id, body, sender_type, content_type, created_at")
      .in("conversation_id", page.map((r) => r.id))
      .order("created_at", { ascending: false })
      .limit(page.length * 4);
    if (msgError) throw msgError;
    for (const m of msgs ?? []) if (!previews.has(m.conversation_id)) previews.set(m.conversation_id, { body: m.body, sender: m.sender_type, content: m.content_type });
  }

  const items: InboxItem[] = page.map((r) => {
    const p = previews.get(r.id);
    return {
      id: r.id,
      status: r.status,
      channel: r.channel,
      contactName: r.contact?.display_name ?? null,
      phone: r.contact?.external_id ?? "",
      preview: p ? (p.body?.slice(0, 120) ?? `(${p.content})`) : null,
      previewFrom: p?.sender ?? null,
      handoffReason: r.handoff_reason,
      unread: r.unread_count,
      assignedTo: r.assigned ? { id: r.assigned.id, name: r.assigned.display_name } : null,
      lastMessageAt: r.last_message_at,
    };
  });
  const last = page[page.length - 1];
  return { items, nextCursor: rows.length > PAGE_SIZE && last ? `${last.last_message_at}|${last.id}` : null };
}

/** Desfase fijo "-03:00" para filtros de fecha; suficiente para America/Montevideo (sin horario de verano desde 2015). */
function offset(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date());
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
  return m ? m[1] : "+00:00";
}

export interface InboxCounts {
  pending: number;
  mine: number;
  ai: number;
  all: number;
  closed: number;
}

export async function getInboxCounts(businessId: string, member: Pick<Member, "id">): Promise<InboxCounts> {
  const head = { count: "exact" as const, head: true };
  const base = () => db().from("conversations").select("id", head).eq("business_id", businessId);
  const [pending, mine, ai, all, closed] = await Promise.all([
    base().eq("status", "pending_human"),
    member.id ? base().eq("status", "human").eq("assigned_member_id", member.id) : Promise.resolve({ count: 0, error: null }),
    base().eq("status", "bot"),
    base().neq("status", "closed"),
    base().eq("status", "closed"),
  ]);
  for (const r of [pending, mine, ai, all, closed]) if (r.error) throw r.error;
  return { pending: pending.count ?? 0, mine: mine.count ?? 0, ai: ai.count ?? 0, all: all.count ?? 0, closed: closed.count ?? 0 };
}

// ── Detalle ────────────────────────────────────────────────────────────────────────────────────────────

export type TimelineEntry =
  | { kind: "message"; id: string; at: string; direction: "inbound" | "outbound"; sender: "customer" | "bot" | "agent" | "system"; senderName: string | null; body: string | null; contentType: string; status: string; sources: string[] }
  | { kind: "event"; id: string; at: string; type: string; from: string | null; to: string | null; actorName: string | null; payload: Record<string, unknown> }
  | { kind: "reminder"; id: string; at: string; reminderKind: string; status: string; appointmentId: string | null };

export interface ConversationDetail {
  conversation: {
    id: string;
    status: ConversationStatus;
    channel: "whatsapp" | "web";
    version: number;
    handoffReason: string | null;
    handoffRequestedAt: string | null;
    summary: string | null;
    unread: number;
    assignedTo: { id: string; name: string } | null;
    createdAt: string;
    lastInboundAt: string | null;
  };
  contact: { id: string; name: string | null; phone: string; customerId: string | null };
  nextAppointment: { id: string; startsAt: string; service: string | null; status: string; timezone: string } | null;
  unanswered: { id: string; question: string; reason: string; status: string; createdAt: string }[];
  timeline: TimelineEntry[];
  /** Instante en que se cierra la ventana de 24 h para escribir texto libre; `null` si ya se cerró o nunca hubo mensaje. */
  windowClosesAt: string | null;
}

export async function getConversationDetail(businessId: string, id: string): Promise<ConversationDetail | null> {
  const { data: conv, error } = await db()
    .from("conversations")
    .select("id, status, channel, version, handoff_reason, handoff_requested_at, summary, unread_count, assigned_member_id, created_at, last_inbound_at, contact_id")
    .eq("id", id)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  if (!conv) return null;

  const [{ data: contact }, { data: members }, { data: msgs }, { data: events }, { data: unanswered }, { data: biz }] = await Promise.all([
    db().from("chat_contacts").select("id, display_name, external_id, customer_id").eq("id", conv.contact_id).eq("business_id", businessId).single(),
    db().from("business_members").select("id, display_name").eq("business_id", businessId),
    db().from("conversation_messages").select("id, direction, sender_type, sender_member_id, body, content_type, status, ai, created_at").eq("conversation_id", id).eq("business_id", businessId).order("created_at").limit(500),
    db().from("conversation_events").select("id, type, from_status, to_status, actor_member_id, payload, created_at").eq("conversation_id", id).eq("business_id", businessId).order("created_at").limit(200),
    db().from("unanswered_questions").select("id, question, reason, status, created_at").eq("conversation_id", id).eq("business_id", businessId).order("created_at", { ascending: false }).limit(20),
    db().from("businesses").select("timezone").eq("id", businessId).single(),
  ]);
  const names = new Map((members ?? []).map((m) => [m.id as string, m.display_name as string]));

  // Recordatorios que el negocio le envió a este teléfono: forman parte del historial del cliente.
  const { data: reminders } = await db()
    .from("messages")
    .select("id, kind, status, sent_at, scheduled_for, created_at, appointment_id")
    .eq("business_id", businessId)
    .eq("to_phone", contact!.external_id)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(20);

  let nextAppointment: ConversationDetail["nextAppointment"] = null;
  if (contact!.customer_id) {
    const { data: appt } = await db()
      .from("appointments")
      .select("id, starts_at, service, status")
      .eq("business_id", businessId)
      .eq("customer_id", contact!.customer_id)
      .in("status", ["scheduled", "rescheduled", "confirmed"])
      .gt("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(1)
      .maybeSingle();
    if (appt) nextAppointment = { id: appt.id, startsAt: appt.starts_at, service: appt.service, status: appt.status, timezone: biz?.timezone ?? "America/Montevideo" };
  }

  const timeline: TimelineEntry[] = [
    ...(msgs ?? []).map((m): TimelineEntry => ({
      kind: "message", id: m.id, at: m.created_at, direction: m.direction, sender: m.sender_type, senderName: m.sender_member_id ? (names.get(m.sender_member_id) ?? null) : null,
      body: m.body, contentType: m.content_type, status: m.status, sources: ((m.ai as { used_source_ids?: string[] } | null)?.used_source_ids ?? []),
    })),
    ...(events ?? []).map((e): TimelineEntry => ({
      kind: "event", id: String(e.id), at: e.created_at, type: e.type, from: e.from_status, to: e.to_status, actorName: e.actor_member_id ? (names.get(e.actor_member_id) ?? null) : null, payload: (e.payload ?? {}) as Record<string, unknown>,
    })),
    ...(reminders ?? []).map((r): TimelineEntry => ({ kind: "reminder", id: r.id, at: r.sent_at ?? r.scheduled_for ?? r.created_at, reminderKind: r.kind, status: r.status, appointmentId: r.appointment_id })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const closes = conv.last_inbound_at ? new Date(new Date(conv.last_inbound_at).getTime() + 24 * 3600 * 1000) : null;
  return {
    conversation: {
      id: conv.id, status: conv.status, channel: conv.channel, version: conv.version, handoffReason: conv.handoff_reason, handoffRequestedAt: conv.handoff_requested_at, summary: conv.summary,
      unread: conv.unread_count, assignedTo: conv.assigned_member_id ? { id: conv.assigned_member_id, name: names.get(conv.assigned_member_id) ?? "—" } : null, createdAt: conv.created_at, lastInboundAt: conv.last_inbound_at,
    },
    contact: { id: contact!.id, name: contact!.display_name, phone: contact!.external_id, customerId: contact!.customer_id },
    nextAppointment,
    unanswered: (unanswered ?? []).map((u) => ({ id: u.id, question: u.question, reason: u.reason, status: u.status, createdAt: u.created_at })),
    timeline,
    windowClosesAt: closes && closes.getTime() > Date.now() ? closes.toISOString() : null,
  };
}

/** Miembros activos del negocio (para el filtro por operador y la reasignación). */
export async function listActiveMembers(businessId: string): Promise<{ id: string; name: string; role: string }[]> {
  const { data, error } = await db().from("business_members").select("id, display_name, role").eq("business_id", businessId).eq("status", "active").order("display_name");
  if (error) throw error;
  return (data ?? []).map((m) => ({ id: m.id, name: m.display_name, role: m.role }));
}

// ── Métricas (06 §18.6) ────────────────────────────────────────────────────────────────────────────────

export interface Metrics {
  days: 7 | 30;
  conversations: number;
  /** % de las conversaciones del período resueltas o cerradas sin haber pasado por una persona. */
  resolvedByAiPct: number | null;
  /** % con una derivación a una persona. */
  handedOffPct: number | null;
  pendingNow: number;
  unansweredOpen: number;
  /** Mediana en segundos entre el primer mensaje del cliente y la primera respuesta del asistente. */
  firstAiResponseSec: number | null;
  /** Mediana en segundos entre la derivación y el primer mensaje de una persona. */
  firstHumanResponseSec: number | null;
  daily: { day: string; ai: number; handedOff: number }[];
  /** Solo para quien puede ver costos (admin/owner). */
  costs: null | {
    monthCostUsd: number;
    monthlyBudgetUsd: number;
    byOperation: { operation: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }[];
  };
}

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
const MAX_CONVERSATIONS = 2000;

export async function getMetrics(businessId: string, days: 7 | 30, timeZone: string, includeCosts: boolean, now: Date = new Date()): Promise<Metrics> {
  const since = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
  const head = { count: "exact" as const, head: true };

  const [convs, pending, unanswered] = await Promise.all([
    db().from("conversations").select("id, status, resolved_by, handoff_requested_at, created_at").eq("business_id", businessId).gte("created_at", since).order("created_at").limit(MAX_CONVERSATIONS),
    db().from("conversations").select("id", head).eq("business_id", businessId).eq("status", "pending_human"),
    db().from("unanswered_questions").select("id", head).eq("business_id", businessId).eq("status", "open"),
  ]);
  for (const r of [convs, pending, unanswered]) if (r.error) throw r.error;
  const rows = convs.data ?? [];

  const handed = rows.filter((c) => c.handoff_requested_at);
  const resolvedByAi = rows.filter((c) => !c.handoff_requested_at && (c.status === "resolved" || c.status === "closed"));

  // Tiempos de respuesta: primer entrante, primera respuesta del asistente y primer mensaje de una persona.
  const ids = rows.map((c) => c.id);
  const firstInbound = new Map<string, number>();
  const firstBot = new Map<string, number>();
  const firstAgent = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db()
      .from("conversation_messages")
      .select("conversation_id, direction, sender_type, created_at")
      .eq("business_id", businessId)
      .in("conversation_id", ids.slice(i, i + 200))
      .order("created_at")
      .limit(5000);
    if (error) throw error;
    for (const m of data ?? []) {
      const t = new Date(m.created_at).getTime();
      if (m.direction === "inbound" && !firstInbound.has(m.conversation_id)) firstInbound.set(m.conversation_id, t);
      if (m.sender_type === "bot" && !firstBot.has(m.conversation_id)) firstBot.set(m.conversation_id, t);
      if (m.sender_type === "agent" && !firstAgent.has(m.conversation_id)) firstAgent.set(m.conversation_id, t);
    }
  }
  const aiTimes = rows.flatMap((c) => (firstInbound.has(c.id) && firstBot.has(c.id) && firstBot.get(c.id)! >= firstInbound.get(c.id)! ? [Math.round((firstBot.get(c.id)! - firstInbound.get(c.id)!) / 1000)] : []));
  const humanTimes = handed.flatMap((c) => {
    const reqAt = new Date(c.handoff_requested_at!).getTime();
    const agent = firstAgent.get(c.id);
    return agent !== undefined && agent >= reqAt ? [Math.round((agent - reqAt) / 1000)] : [];
  });

  const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));
  const bucket = new Map<string, { ai: number; handedOff: number }>();
  for (let d = days - 1; d >= 0; d--) bucket.set(dayOf(new Date(now.getTime() - d * 24 * 3600 * 1000).toISOString()), { ai: 0, handedOff: 0 });
  for (const c of rows) {
    const b = bucket.get(dayOf(c.created_at));
    if (b) {
      if (c.handoff_requested_at) b.handedOff++;
      else b.ai++;
    }
  }

  let costs: Metrics["costs"] = null;
  if (includeCosts) {
    const monthStart = startOfMonth(now, timeZone);
    const [{ data: usage, error: usageError }, { data: settings }] = await Promise.all([
      db().from("chatbot_usage").select("operation, model, input_tokens, cache_read_tokens, output_tokens, cost_usd, created_at").eq("business_id", businessId).gte("created_at", since).limit(20000),
      db().from("chatbot_settings").select("monthly_budget_usd").eq("business_id", businessId).maybeSingle(),
    ]);
    if (usageError) throw usageError;
    const { data: month, error: monthError } = await db().from("chatbot_usage").select("cost_usd").eq("business_id", businessId).gte("created_at", monthStart.toISOString()).limit(50000);
    if (monthError) throw monthError;
    const groups = new Map<string, Metrics["costs"] extends infer T ? (T extends { byOperation: (infer R)[] } ? R : never) : never>();
    for (const u of usage ?? []) {
      const key = `${u.operation}|${u.model}`;
      const g = groups.get(key) ?? { operation: u.operation, model: u.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      g.calls++;
      g.inputTokens += u.input_tokens + u.cache_read_tokens;
      g.outputTokens += u.output_tokens;
      g.costUsd += Number(u.cost_usd);
      groups.set(key, g);
    }
    costs = {
      monthCostUsd: Math.round((month ?? []).reduce((s, r) => s + Number(r.cost_usd), 0) * 1e6) / 1e6,
      monthlyBudgetUsd: settings ? Number(settings.monthly_budget_usd) : 20,
      byOperation: [...groups.values()].sort((a, b) => b.costUsd - a.costUsd),
    };
  }

  return {
    days,
    conversations: rows.length,
    resolvedByAiPct: pct(resolvedByAi.length, rows.length),
    handedOffPct: pct(handed.length, rows.length),
    pendingNow: pending.count ?? 0,
    unansweredOpen: unanswered.count ?? 0,
    firstAiResponseSec: median(aiTimes),
    firstHumanResponseSec: median(humanTimes),
    daily: [...bucket].map(([day, v]) => ({ day, ...v })),
    costs,
  };
}
