import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";
import { loadAppointment, notifyAppointment, type NotifyResult } from "./notify";
import { cancelReminders, planReminders } from "./reminders";

/**
 * Casos de uso de turnos, compartidos por la API (/api/appointments) y el panel (Server Actions).
 * Las validaciones de formato viven aquí para que ambos se comporten igual.
 */

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const FINAL_STATUSES = ["cancelled", "completed", "no_show"];
export const STATUS_UPDATES = ["confirmed", "cancelled", "completed", "no_show"] as const;
export type StatusUpdate = (typeof STATUS_UPDATES)[number];

/** "�" = bytes que no eran UTF-8: mejor rechazar que enviar "Espa�a" por WhatsApp. */
function assertCleanText(...values: (string | undefined | null)[]) {
  if (values.some((v) => typeof v === "string" && v.includes("�"))) {
    throw new ServiceError(
      "Texto con caracteres inválidos: envía el body en UTF-8 (Content-Type: application/json; charset=utf-8)",
    );
  }
}

export interface CreateAppointmentInput {
  businessId: string;
  customerName: string;
  customerPhone: string;
  startsAt: Date;
  endsAt?: Date | null;
  service?: string | null;
  notes?: string | null;
  /** Enviar la confirmación por WhatsApp ahora (por defecto: true). */
  notify?: boolean;
}

export async function createAppointment(input: CreateAppointmentInput) {
  const name = input.customerName.trim();
  if (!name) throw new ServiceError("Falta el nombre del cliente");
  assertCleanText(name, input.service, input.notes);

  const phone = normalizePhone(input.customerPhone);
  if (phone.length < 8 || phone.length > 15) {
    throw new ServiceError("El teléfono debe estar en formato internacional (ej. 59899123456)");
  }
  if (Number.isNaN(input.startsAt.getTime())) throw new ServiceError("Fecha inválida");
  if (input.startsAt.getTime() <= Date.now()) throw new ServiceError("El turno debe ser en el futuro");
  if (input.endsAt && input.endsAt <= input.startsAt) {
    throw new ServiceError("La hora de fin debe ser posterior al inicio");
  }

  const db = getSupabaseAdmin();

  const { data: business, error: businessError } = await db
    .from("businesses")
    .select("id")
    .eq("id", input.businessId)
    .maybeSingle();
  if (businessError) throw businessError;
  if (!business) throw new ServiceError("El negocio no existe", 404);

  const { data: customer, error: customerError } = await db
    .from("customers")
    .upsert({ business_id: business.id, phone, name }, { onConflict: "business_id,phone" })
    .select("id")
    .single();
  if (customerError) throw customerError;

  const { data: created, error: apptError } = await db
    .from("appointments")
    .insert({
      business_id: business.id,
      customer_id: customer.id,
      starts_at: input.startsAt.toISOString(),
      ends_at: input.endsAt?.toISOString() ?? null,
      service: input.service?.trim() || null,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (apptError) throw apptError;

  const appointment = (await loadAppointment(created.id))!;
  const reminders = await planReminders(appointment);
  const confirmation =
    input.notify === false ? null : await notifyAppointment(appointment, "confirmation");

  return { appointment, reminders, confirmation };
}

export interface UpdateAppointmentInput {
  status?: StatusUpdate;
  startsAt?: Date;
  /** Avisar al cliente de la cancelación / nueva fecha (por defecto: true). */
  notify?: boolean;
}

/**
 * - startsAt → reprograma: cancela recordatorios, crea nuevos y avisa la nueva fecha.
 * - cancelled → cancela recordatorios y avisa al cliente.
 * - confirmed → los recordatorios siguientes usan la plantilla de "turno confirmado".
 * - completed / no_show → cancela recordatorios pendientes.
 */
export async function updateAppointment(id: string, input: UpdateAppointmentInput) {
  if (input.status && input.startsAt) throw new ServiceError("Envía status o starts_at, no ambos");
  if (input.status && !STATUS_UPDATES.includes(input.status)) {
    throw new ServiceError(`status debe ser uno de: ${STATUS_UPDATES.join(", ")}`);
  }
  if (input.startsAt) {
    if (Number.isNaN(input.startsAt.getTime())) throw new ServiceError("Fecha inválida");
    if (input.startsAt.getTime() <= Date.now()) throw new ServiceError("La nueva fecha debe ser futura");
  }
  if (!input.status && !input.startsAt) throw new ServiceError("Nada para actualizar");

  const appointment = await loadAppointment(id);
  if (!appointment) throw new ServiceError("El turno no existe", 404);
  if (FINAL_STATUSES.includes(appointment.status)) {
    throw new ServiceError(`El turno ya está en estado ${appointment.status}`, 409);
  }

  const db = getSupabaseAdmin();
  const notify = input.notify !== false;
  let notification: NotifyResult | null = null;

  if (input.startsAt) {
    await cancelReminders(id);
    const { error } = await db
      .from("appointments")
      .update({ starts_at: input.startsAt.toISOString(), status: "rescheduled" })
      .eq("id", id);
    if (error) throw error;

    const updated = (await loadAppointment(id))!;
    await planReminders(updated);
    if (notify) notification = await notifyAppointment(updated, "confirmation");
  } else {
    if (input.status !== "confirmed") await cancelReminders(id);
    const { error } = await db.from("appointments").update({ status: input.status }).eq("id", id);
    if (error) throw error;
    if (input.status === "cancelled" && notify) {
      notification = await notifyAppointment(appointment, "cancellation");
    }
  }

  return { appointment: await loadAppointment(id), notification };
}
