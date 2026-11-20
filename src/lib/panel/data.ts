import "server-only";
import { DAY_MS, startOfZonedDay } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Consultas de solo lectura del panel (Data Access Layer).
 * Todo corre en el servidor con la clave secreta; nunca se envía al navegador.
 */

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "rescheduled"
  | "cancelled"
  | "completed"
  | "no_show";

export type MessageStatus = "queued" | "accepted" | "sent" | "delivered" | "read" | "failed" | "cancelled";

export interface Business {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
}

export interface AgendaMessage {
  kind: string;
  status: MessageStatus;
  scheduled_for: string | null;
}

export interface AgendaItem {
  id: string;
  starts_at: string;
  status: AppointmentStatus;
  service: string | null;
  customer: { name: string; phone: string };
  business: { name: string; timezone: string };
  messages: AgendaMessage[];
}

export type AgendaView = "upcoming" | "past" | "cancelled";

const ACTIVE: AppointmentStatus[] = ["scheduled", "confirmed", "rescheduled"];

/** Solo el negocio del miembro: el panel nunca lista negocios ajenos. */
export async function getBusinesses(businessId: string): Promise<Business[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("businesses")
    .select("id, name, timezone, address")
    .eq("id", businessId)
    .order("created_at");
  if (error) throw error;
  return data;
}

export async function getAgenda(view: AgendaView, businessId: string): Promise<AgendaItem[]> {
  const now = new Date().toISOString();
  let query = getSupabaseAdmin()
    .from("appointments")
    .select(
      `id, starts_at, status, service,
       customer:customers ( name, phone ),
       business:businesses ( name, timezone ),
       messages ( kind, status, scheduled_for )`,
    )
    .eq("business_id", businessId);

  if (view === "upcoming") {
    query = query.gte("starts_at", now).in("status", ACTIVE).order("starts_at").limit(100);
  } else if (view === "past") {
    query = query.lt("starts_at", now).neq("status", "cancelled").order("starts_at", { ascending: false }).limit(50);
  } else {
    query = query.eq("status", "cancelled").order("starts_at", { ascending: false }).limit(50);
  }

  const { data, error } = await query.returns<AgendaItem[]>();
  if (error) throw error;
  return data;
}

export interface PanelStats {
  today: number;
  next7Days: number;
  confirmationRate: number | null;
  readRate: number | null;
  sentLast7Days: number;
  pendingReminders: number;
}

export async function getStats(timeZone: string, businessId: string): Promise<PanelStats> {
  const db = getSupabaseAdmin();
  const now = new Date();
  const todayStart = startOfZonedDay(now, timeZone);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const in7 = new Date(now.getTime() + 7 * DAY_MS);
  const ago30 = new Date(now.getTime() - 30 * DAY_MS);
  const ago7 = new Date(now.getTime() - 7 * DAY_MS);

  const count = { count: "exact" as const, head: true };
  const scoped = (table: "appointments" | "messages") => db.from(table).select("id", count).eq("business_id", businessId);

  const [today, next7, decided, confirmed, sent, read, pending] = await Promise.all([
    scoped("appointments")
      .gte("starts_at", todayStart.toISOString()).lt("starts_at", tomorrowStart.toISOString())
      .in("status", [...ACTIVE, "completed"]),
    scoped("appointments")
      .gte("starts_at", now.toISOString()).lt("starts_at", in7.toISOString()).in("status", ACTIVE),
    // Turnos de los últimos 30 días en los que el cliente ya "decidió" algo o se cerró.
    scoped("appointments")
      .gte("created_at", ago30.toISOString()).neq("status", "scheduled"),
    scoped("appointments")
      .gte("created_at", ago30.toISOString()).in("status", ["confirmed", "completed"]),
    scoped("messages")
      .gte("created_at", ago7.toISOString()).in("status", ["accepted", "sent", "delivered", "read"]),
    scoped("messages")
      .gte("created_at", ago7.toISOString()).eq("status", "read"),
    scoped("messages").eq("status", "queued"),
  ]);

  for (const r of [today, next7, decided, confirmed, sent, read, pending]) if (r.error) throw r.error;

  const rate = (num: number | null, den: number | null) =>
    den ? Math.round(((num ?? 0) / den) * 100) : null;

  return {
    today: today.count ?? 0,
    next7Days: next7.count ?? 0,
    confirmationRate: rate(confirmed.count, decided.count),
    readRate: rate(read.count, sent.count),
    sentLast7Days: sent.count ?? 0,
    pendingReminders: pending.count ?? 0,
  };
}

export interface ActivityItem {
  id: string;
  type: "reply" | "failed";
  at: string;
  text: string;
  intent: string | null;
  customerName: string | null;
  appointmentId: string | null;
}

/** Últimas respuestas de clientes y envíos fallidos. */
export async function getRecentActivity(businessId: string, limit = 8): Promise<ActivityItem[]> {
  const db = getSupabaseAdmin();

  const [inbound, failed] = await Promise.all([
    db.from("inbound_messages")
      .select("id, body, intent, received_at, appointment_id, appointment:appointments!inner ( business_id, customer:customers ( name ) )")
      .eq("appointment.business_id", businessId)
      .not("appointment_id", "is", null)
      .order("received_at", { ascending: false })
      .limit(limit)
      .returns<{
        id: string; body: string | null; intent: string | null; received_at: string;
        appointment_id: string | null; appointment: { customer: { name: string } } | null;
      }[]>(),
    db.from("messages")
      .select("id, kind, failed_at, appointment_id, error, appointment:appointments ( customer:customers ( name ) )")
      .eq("business_id", businessId)
      .eq("status", "failed")
      .order("failed_at", { ascending: false })
      .limit(limit)
      .returns<{
        id: string; kind: string; failed_at: string; appointment_id: string | null;
        error: { message?: string } | null; appointment: { customer: { name: string } } | null;
      }[]>(),
  ]);
  if (inbound.error) throw inbound.error;
  if (failed.error) throw failed.error;

  const items: ActivityItem[] = [
    ...inbound.data.map((m) => ({
      id: m.id,
      type: "reply" as const,
      at: m.received_at,
      text: m.body ?? "(mensaje sin texto)",
      intent: m.intent,
      customerName: m.appointment?.customer.name ?? null,
      appointmentId: m.appointment_id,
    })),
    ...failed.data.map((m) => ({
      id: m.id,
      type: "failed" as const,
      at: m.failed_at,
      text: m.error?.message ?? "No se pudo enviar",
      intent: null,
      customerName: m.appointment?.customer.name ?? null,
      appointmentId: m.appointment_id,
    })),
  ];

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export interface TimelineMessage {
  id: string;
  direction: "out";
  kind: string;
  status: MessageStatus;
  template_name: string;
  variables: Record<string, string>;
  scheduled_for: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  error: { message?: string } | null;
}

export interface TimelineReply {
  id: string;
  direction: "in";
  body: string | null;
  intent: string | null;
  received_at: string;
}

export interface AppointmentDetail extends Omit<AgendaItem, "messages" | "business"> {
  created_at: string;
  notes: string | null;
  business: { name: string; timezone: string; address: string | null };
  timeline: (TimelineMessage | TimelineReply)[];
}

export async function getAppointmentDetail(id: string, businessId: string): Promise<AppointmentDetail | null> {
  const db = getSupabaseAdmin();

  const { data: appt, error } = await db
    .from("appointments")
    .select(
      `id, starts_at, status, service, notes, created_at,
       customer:customers ( name, phone ),
       business:businesses ( name, timezone, address ),
       messages ( id, kind, status, template_name, variables, scheduled_for, created_at,
                  sent_at, delivered_at, read_at, failed_at, error )`,
    )
    .eq("id", id)
    .eq("business_id", businessId)
    .maybeSingle<Omit<AppointmentDetail, "timeline"> & { messages: Omit<TimelineMessage, "direction">[] }>();
  // (messages se separa abajo y se une con las respuestas en una sola línea de tiempo)
  if (error) throw error;
  if (!appt) return null;

  const { data: replies, error: repliesError } = await db
    .from("inbound_messages")
    .select("id, body, intent, received_at")
    .eq("appointment_id", id);
  if (repliesError) throw repliesError;

  const timeline: AppointmentDetail["timeline"] = [
    ...appt.messages.map((m) => ({ ...m, direction: "out" as const })),
    ...replies.map((r) => ({ ...r, direction: "in" as const })),
  ].sort((a, b) => timelineAt(a).localeCompare(timelineAt(b)));

  const { messages: _messages, ...rest } = appt;
  void _messages;
  return { ...rest, timeline };
}

/** Momento en que un evento aparece en la línea de tiempo. */
export function timelineAt(item: TimelineMessage | TimelineReply): string {
  if (item.direction === "in") return item.received_at;
  if (item.status === "queued" || item.status === "cancelled") return item.scheduled_for ?? item.created_at;
  // Los recordatorios se crean al reservar pero salen después: usar su hora programada como respaldo.
  return item.sent_at ?? item.scheduled_for ?? item.created_at;
}
