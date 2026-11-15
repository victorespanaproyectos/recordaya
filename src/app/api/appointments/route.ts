import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { createAppointment, ServiceError } from "@/lib/appointments/service";
import { parseIsoWithOffset } from "@/lib/dates";
import { badRequest, isNonEmptyString, readJson, serverError, unauthorized } from "@/lib/http";

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

  const startsAt = parseIsoWithOffset(body.starts_at);
  if (!startsAt) return badRequest('starts_at debe ser ISO con zona horaria (ej. "2026-11-17T15:30:00-03:00")');

  let endsAt: Date | null = null;
  if (body.ends_at !== undefined) {
    endsAt = parseIsoWithOffset(body.ends_at);
    if (!endsAt) return badRequest("ends_at inválido");
  }

  try {
    const result = await createAppointment({
      businessId: body.business_id,
      customerName: body.customer!.name,
      customerPhone: String(body.customer?.phone ?? ""),
      startsAt,
      endsAt,
      service: body.service,
      notes: body.notes,
      notify: body.notify,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return serverError("appointments", error);
  }
}
