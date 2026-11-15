import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { loadAppointment, notifyAppointment } from "@/lib/appointments/notify";
import { planReminders } from "@/lib/appointments/reminders";
import { parseIsoWithOffset } from "@/lib/dates";
import { badRequest, isNonEmptyString, notFound, readJson, serverError, unauthorized } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";

interface CreateAppointmentBody {
  business_id: string;
  customer: { name: string; phone: string };
  /** ISO con zona horaria, ej. "2026-11-17T15:30:00-03:00". */
  starts_at: string;
  ends_at?: string;
  service?: string;
  notes?: string;
  /** Enviar la confirmación de reserva por WhatsApp ahora (por defecto: true). */
  notify?: boolean;
}

/**
 * POST /api/appointments
 * Crea un turno (y el cliente si no existe), programa los recordatorios 24 h / 2 h
 * y, opcionalmente, envía la confirmación de reserva.
 * Requiere: Authorization: Bearer <ADMIN_API_KEY>
 */
export async function POST(request: Request) {
  if (!isAuthorizedAdmin(request)) return unauthorized();

  const body = await readJson<CreateAppointmentBody>(request);
  if (!body) return badRequest("Body JSON inválido");

  if (!isNonEmptyString(body.business_id)) return badRequest("Falta business_id");
  if (!isNonEmptyString(body.customer?.name)) return badRequest("Falta customer.name");
  const phone = normalizePhone(String(body.customer?.phone ?? ""));
  if (phone.length < 8 || phone.length > 15) {
    return badRequest("customer.phone debe estar en formato internacional (ej. 59899123456)");
  }

  const startsAt = parseIsoWithOffset(body.starts_at);
  if (!startsAt) return badRequest('starts_at debe ser ISO con zona horaria (ej. "2026-11-17T15:30:00-03:00")');
  if (startsAt.getTime() <= Date.now()) return badRequest("starts_at debe ser futuro");

  let endsAt: Date | null = null;
  if (body.ends_at !== undefined) {
    endsAt = parseIsoWithOffset(body.ends_at);
    if (!endsAt || endsAt <= startsAt) return badRequest("ends_at inválido o anterior a starts_at");
  }

  try {
    const db = getSupabaseAdmin();

    const { data: business, error: businessError } = await db
      .from("businesses")
      .select("id")
      .eq("id", body.business_id)
      .maybeSingle();
    if (businessError) throw businessError;
    if (!business) return notFound("El negocio no existe");

    const { data: customer, error: customerError } = await db
      .from("customers")
      .upsert(
        { business_id: business.id, phone, name: body.customer!.name.trim() },
        { onConflict: "business_id,phone" },
      )
      .select("id")
      .single();
    if (customerError) throw customerError;

    const { data: created, error: apptError } = await db
      .from("appointments")
      .insert({
        business_id: business.id,
        customer_id: customer.id,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt?.toISOString() ?? null,
        service: body.service?.trim() || null,
        notes: body.notes?.trim() || null,
      })
      .select("id")
      .single();
    if (apptError) throw apptError;

    const appointment = (await loadAppointment(created.id))!;
    const reminders = await planReminders(appointment);
    const confirmation =
      body.notify === false ? null : await notifyAppointment(appointment, "confirmation");

    return Response.json({ appointment, reminders, confirmation }, { status: 201 });
  } catch (error) {
    return serverError("appointments", error);
  }
}
