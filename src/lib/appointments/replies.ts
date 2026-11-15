import { formatFecha, formatHora } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { sendText } from "@/lib/whatsapp/client";
import { loadAppointment, notifyAppointment, type AppointmentContext } from "./notify";
import { parseReplyIntent } from "./intent";
import { cancelReminders } from "./reminders";

const ACTIVE = ["scheduled", "rescheduled", "confirmed"];

/**
 * Turno al que se refiere la respuesta:
 * 1) si el cliente respondió citando uno de nuestros mensajes, el turno de ese mensaje;
 * 2) si no, su próximo turno activo.
 */
async function findAppointmentId(fromPhone: string, replyTo: string | null): Promise<string | null> {
  const db = getSupabaseAdmin();

  if (replyTo) {
    const { data } = await db
      .from("messages")
      .select("appointment_id")
      .eq("wa_message_id", replyTo)
      .maybeSingle();
    if (data?.appointment_id) return data.appointment_id;
  }

  const { data, error } = await db
    .from("appointments")
    .select("id, customers!inner(phone)")
    .eq("customers.phone", fromPhone)
    .in("status", ACTIVE)
    .gt("starts_at", new Date().toISOString())
    .order("starts_at")
    .limit(1);
  if (error) throw error;
  return data?.[0]?.id ?? null;
}

export interface HandleReplyInput {
  inboundId: string;
  fromPhone: string;
  text: string | null;
  replyTo: string | null;
}

/**
 * Aplica la respuesta del cliente a su turno y le contesta.
 * Se llama una sola vez por mensaje entrante (el webhook descarta los duplicados).
 */
export async function handleCustomerReply(input: HandleReplyInput): Promise<void> {
  const db = getSupabaseAdmin();
  const intent = parseReplyIntent(input.text);
  const appointmentId = await findAppointmentId(input.fromPhone, input.replyTo);

  await db
    .from("inbound_messages")
    .update({ intent, appointment_id: appointmentId })
    .eq("id", input.inboundId);

  if (!appointmentId) return; // no tiene turnos próximos: no contestamos nada
  const appt = await loadAppointment(appointmentId);
  if (!appt) return;

  if (!ACTIVE.includes(appt.status) || new Date(appt.starts_at).getTime() <= Date.now()) {
    if (intent !== "unknown") {
      await reply(appt, `Ese turno ya no está activo. Si necesitas uno nuevo, escríbenos a ${appt.business.name}.`);
    }
    return;
  }

  const when = describe(appt);

  if (intent === "confirm") {
    if (appt.status !== "confirmed") {
      const { error } = await db.from("appointments").update({ status: "confirmed" }).eq("id", appt.id);
      if (error) throw error;
    }
    await reply(appt, `¡Gracias, ${firstName(appt)}! Tu turno del ${when} en ${appt.business.name} quedó confirmado. ✅`);
    return;
  }

  if (intent === "cancel") {
    await cancelReminders(appt.id);
    const { error } = await db.from("appointments").update({ status: "cancelled" }).eq("id", appt.id);
    if (error) throw error;
    await notifyAppointment(appt, "cancellation");
    return;
  }

  await reply(
    appt,
    `Hola ${firstName(appt)}, tienes un turno el ${when} en ${appt.business.name}.\nResponde *1* para confirmar o *2* para cancelar.`,
  );
}

function describe(appt: AppointmentContext): string {
  const start = new Date(appt.starts_at);
  return `${formatFecha(start, appt.business.timezone)} a las ${formatHora(start, appt.business.timezone)}`;
}

function firstName(appt: AppointmentContext): string {
  return appt.customer.name.split(/\s+/)[0];
}

/** Texto libre (dentro de la ventana de 24 h) registrado en `messages`. */
async function reply(appt: AppointmentContext, body: string): Promise<void> {
  const db = getSupabaseAdmin();
  const base = {
    business_id: appt.business_id,
    appointment_id: appt.id,
    to_phone: appt.customer.phone,
    kind: "reply",
    template_name: "text",
    variables: { body },
  };
  try {
    const result = await sendText(appt.customer.phone, body);
    await db.from("messages").insert({ ...base, status: "accepted", wa_message_id: result.messageId });
  } catch (err) {
    console.error("[replies] No se pudo contestar:", err);
    await db.from("messages").insert({
      ...base,
      status: "failed",
      failed_at: new Date().toISOString(),
      error: { message: err instanceof Error ? err.message : String(err) },
    });
  }
}
