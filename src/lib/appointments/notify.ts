import { formatFecha, formatHora } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sendTemplate, WhatsAppApiError } from "@/lib/whatsapp/client";
import {
  cancelacionParams,
  confirmacionParams,
  TEMPLATES,
  type TemplateKey,
} from "@/lib/whatsapp/templates";

export interface AppointmentContext {
  id: string;
  business_id: string;
  starts_at: string;
  service: string | null;
  customer: { name: string; phone: string };
  business: { name: string; timezone: string };
}

type NotifyKind = "confirmation" | "cancellation";

export interface NotifyResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
}

/**
 * Envía en el momento un aviso del turno (confirmación de reserva o cancelación)
 * y lo registra en `messages`. No lanza errores de WhatsApp: los devuelve.
 */
export async function notifyAppointment(
  appt: AppointmentContext,
  kind: NotifyKind,
): Promise<NotifyResult> {
  const start = new Date(appt.starts_at);
  const fecha = formatFecha(start, appt.business.timezone);
  const hora = formatHora(start, appt.business.timezone);

  let templateKey: TemplateKey;
  let variables: Record<string, string>;
  let params;
  if (kind === "confirmation") {
    templateKey = "confirmacion";
    const v = {
      nombre: appt.customer.name,
      negocio: appt.business.name,
      servicio: appt.service || "tu turno",
      fecha,
      hora,
    };
    variables = { ...v };
    params = confirmacionParams(v);
  } else {
    templateKey = "cancelacion";
    const v = { nombre: appt.customer.name, negocio: appt.business.name, fecha, hora };
    variables = { ...v };
    params = cancelacionParams(v);
  }
  const template = TEMPLATES[templateKey];

  const base = {
    business_id: appt.business_id,
    appointment_id: appt.id,
    to_phone: appt.customer.phone,
    kind,
    template_name: template,
    variables,
  };

  const db = getSupabaseAdmin();
  try {
    const result = await sendTemplate({ to: appt.customer.phone, template, bodyParams: params });
    const { error } = await db
      .from("messages")
      .insert({ ...base, status: "accepted", sent_at: new Date().toISOString(), wa_message_id: result.messageId });
    if (error) console.error("[notify] Enviado pero no se pudo guardar:", error);
    return { ok: true, waMessageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    await db.from("messages").insert({
      ...base,
      status: "failed",
      failed_at: new Date().toISOString(),
      error:
        err instanceof WhatsAppApiError
          ? { message: err.message, code: err.code, details: err.details }
          : { message },
    });
    return { ok: false, error: message };
  }
}

/** Trae el turno con cliente y negocio, en el formato que usan los avisos. */
export async function loadAppointment(id: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("appointments")
    .select(
      `id, business_id, starts_at, ends_at, service, notes, status, created_at,
       customer:customers ( id, name, phone ),
       business:businesses ( name, timezone )`,
    )
    .eq("id", id)
    .maybeSingle<AppointmentContext & {
      ends_at: string | null;
      notes: string | null;
      status: string;
      created_at: string;
      customer: { id: string; name: string; phone: string };
    }>();
  if (error) throw error;
  return data;
}
