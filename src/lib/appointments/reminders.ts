import { HOUR_MS, formatFecha, formatHora } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cancelScheduled, maxDelayMs, scheduleReminder } from "@/lib/scheduler/qstash";
import { sendTemplate, WhatsAppApiError } from "@/lib/whatsapp/client";
import {
  recordatorioConfirmadoParams,
  recordatorioParams,
  TEMPLATES,
} from "@/lib/whatsapp/templates";

/** Recordatorios que se programan para cada turno: tipo y anticipación. */
export const REMINDER_PLAN = [
  { kind: "reminder_24h", before: 24 * HOUR_MS },
  { kind: "reminder_2h", before: 2 * HOUR_MS },
] as const;

/** No programamos recordatorios que caerían en menos de este margen (ya "pasaron"). */
const MIN_LEAD_MS = 60 * 1000;

/** Estados del turno en los que todavía tiene sentido recordar. */
const ACTIVE_APPOINTMENT_STATUSES = ["scheduled", "confirmed", "rescheduled"];

export interface AppointmentForReminders {
  id: string;
  business_id: string;
  starts_at: string;
  customer: { phone: string };
}

/**
 * Crea las filas de recordatorio (status "queued") de un turno y las programa en QStash.
 * Los que caen a más de QSTASH_MAX_DELAY_DAYS quedan sin schedule_id; los agenda el job "dispatch".
 */
export async function planReminders(appointment: AppointmentForReminders) {
  const db = getSupabaseAdmin();
  const startsAt = new Date(appointment.starts_at).getTime();
  const now = Date.now();

  const rows = REMINDER_PLAN.map(({ kind, before }) => ({
    kind,
    sendAt: new Date(startsAt - before),
  }))
    .filter(({ sendAt }) => sendAt.getTime() - now > MIN_LEAD_MS)
    .map(({ kind, sendAt }) => ({
      business_id: appointment.business_id,
      appointment_id: appointment.id,
      to_phone: appointment.customer.phone,
      kind,
      template_name: TEMPLATES.recordatorio,
      status: "queued",
      scheduled_for: sendAt.toISOString(),
    }));

  if (rows.length === 0) return [];

  const { data, error } = await db
    .from("messages")
    .insert(rows)
    .select("id, kind, scheduled_for");
  if (error) throw error;

  for (const message of data) {
    try {
      await scheduleIfDue(message.id, new Date(message.scheduled_for));
    } catch (err) {
      // Queda "queued" sin schedule_id: el job "dispatch" lo vuelve a intentar.
      console.error(`[reminders] No se pudo programar ${message.id}:`, err);
    }
  }
  return data as { id: string; kind: string; scheduled_for: string }[];
}

/** Programa en QStash si la fecha está dentro de la demora máxima permitida. */
export async function scheduleIfDue(messageId: string, sendAt: Date): Promise<boolean> {
  if (sendAt.getTime() - Date.now() > maxDelayMs()) return false;

  const scheduleId = await scheduleReminder(messageId, sendAt);
  const { error } = await getSupabaseAdmin()
    .from("messages")
    .update({ schedule_id: scheduleId })
    .eq("id", messageId)
    .eq("status", "queued");
  if (error) throw error;
  return true;
}

/** Cancela los recordatorios pendientes de un turno (en la base y en QStash). */
export async function cancelReminders(appointmentId: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("messages")
    .update({ status: "cancelled" })
    .eq("appointment_id", appointmentId)
    .eq("status", "queued")
    .select("id, schedule_id");
  if (error) throw error;

  for (const message of data) {
    if (message.schedule_id) await cancelScheduled(message.schedule_id);
  }
  return data.length;
}

export type SendReminderResult =
  | { outcome: "sent"; waMessageId: string }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Envía un recordatorio ya programado. Lo llama el job de QStash.
 * - Errores de WhatsApp 4xx (número inválido, plantilla mal) → se marca "failed", sin reintentos.
 * - Errores 5xx / de red → se lanza la excepción para que QStash reintente.
 */
export async function sendReminder(messageId: string): Promise<SendReminderResult> {
  const db = getSupabaseAdmin();

  const { data: message, error } = await db
    .from("messages")
    .select(
      `id, status, kind, to_phone,
       appointment:appointments (
         id, starts_at, status, service,
         customer:customers ( name, phone ),
         business:businesses ( name, timezone, address )
       )`,
    )
    .eq("id", messageId)
    .maybeSingle<ReminderRow>();

  if (error) throw error;
  if (!message) return { outcome: "skipped", reason: "El mensaje no existe" };
  if (message.status !== "queued") {
    return { outcome: "skipped", reason: `El mensaje ya está en estado ${message.status}` };
  }

  const appt = message.appointment;
  if (!appt || !ACTIVE_APPOINTMENT_STATUSES.includes(appt.status)) {
    await db.from("messages").update({ status: "cancelled" }).eq("id", message.id);
    return { outcome: "skipped", reason: "El turno ya no está activo" };
  }
  if (new Date(appt.starts_at).getTime() <= Date.now()) {
    await db.from("messages").update({ status: "cancelled" }).eq("id", message.id);
    return { outcome: "skipped", reason: "El turno ya pasó" };
  }

  const { template, params, variables } = buildReminder(appt);

  try {
    const result = await sendTemplate({ to: message.to_phone, template, bodyParams: params });
    const { error: updateError } = await db
      .from("messages")
      .update({
        status: "accepted",
        sent_at: new Date().toISOString(),
        template_name: template,
        variables,
        wa_message_id: result.messageId,
      })
      .eq("id", message.id);
    if (updateError) console.error("[reminders] Enviado pero no se pudo actualizar:", updateError);
    return { outcome: "sent", waMessageId: result.messageId };
  } catch (err) {
    if (err instanceof WhatsAppApiError && err.httpStatus >= 400 && err.httpStatus < 500) {
      await db
        .from("messages")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          template_name: template,
          variables,
          error: { message: err.message, code: err.code, details: err.details },
        })
        .eq("id", message.id);
      return { outcome: "failed", reason: err.message };
    }
    throw err;
  }
}

interface ReminderRow {
  id: string;
  status: string;
  kind: string;
  to_phone: string;
  appointment: {
    id: string;
    starts_at: string;
    status: string;
    service: string | null;
    customer: { name: string; phone: string };
    business: { name: string; timezone: string; address: string | null };
  } | null;
}

/** Si el cliente ya confirmó, usamos la plantilla de "turno confirmado"; si no, la que pide confirmar. */
function buildReminder(appt: NonNullable<ReminderRow["appointment"]>) {
  const start = new Date(appt.starts_at);
  const tz = appt.business.timezone;
  const fecha = formatFecha(start, tz);
  const hora = formatHora(start, tz);

  if (appt.status === "confirmed") {
    const variables = {
      servicio: appt.service || "tu turno",
      negocio: appt.business.name,
      fecha,
      hora,
      direccion: appt.business.address || appt.business.name,
    };
    return {
      template: TEMPLATES.recordatorioConfirmado,
      params: recordatorioConfirmadoParams(variables),
      variables,
    };
  }

  const variables = { nombre: appt.customer.name, fecha, hora, negocio: appt.business.name };
  return { template: TEMPLATES.recordatorio, params: recordatorioParams(variables), variables };
}
