import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { loadAppointment, notifyAppointment, type NotifyResult } from "@/lib/appointments/notify";
import { cancelReminders, planReminders } from "@/lib/appointments/reminders";
import { parseIsoWithOffset } from "@/lib/dates";
import { badRequest, notFound, readJson, serverError, unauthorized } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINAL_STATUSES = ["cancelled", "completed", "no_show"];

/**
 * GET /api/appointments/:id
 * Devuelve el turno con su cliente y el historial de mensajes.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/appointments/[id]">) {
  if (!isAuthorizedAdmin(request)) return unauthorized();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return notFound();

  try {
    const appointment = await loadAppointment(id);
    if (!appointment) return notFound();

    const { data: messages, error } = await getSupabaseAdmin()
      .from("messages")
      .select("id, kind, status, template_name, scheduled_for, sent_at, delivered_at, read_at, failed_at, error, created_at")
      .eq("appointment_id", id)
      .order("created_at");
    if (error) throw error;

    return Response.json({ appointment, messages });
  } catch (error) {
    return serverError("appointments/:id", error);
  }
}

interface PatchBody {
  /** Cambiar estado: confirmar, cancelar, marcar como completado o ausente. */
  status?: "confirmed" | "cancelled" | "completed" | "no_show";
  /** Reprogramar: nueva fecha ISO con zona horaria. */
  starts_at?: string;
  /** Avisar al cliente por WhatsApp de la cancelación / nueva fecha (por defecto: true). */
  notify?: boolean;
}

/**
 * PATCH /api/appointments/:id
 * - { starts_at }            → reprograma: cancela recordatorios, crea nuevos y avisa la nueva fecha.
 * - { status: "cancelled" }  → cancela recordatorios y avisa al cliente.
 * - { status: "confirmed" }  → los recordatorios siguientes usan la plantilla de "turno confirmado".
 * - { status: "completed" | "no_show" } → cancela recordatorios pendientes.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/appointments/[id]">) {
  if (!isAuthorizedAdmin(request)) return unauthorized();
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return notFound();

  const body = await readJson<PatchBody>(request);
  if (!body) return badRequest("Body JSON inválido");
  if (body.status && body.starts_at) return badRequest("Envía status o starts_at, no ambos");

  const allowed = ["confirmed", "cancelled", "completed", "no_show"];
  if (body.status !== undefined && !allowed.includes(body.status)) {
    return badRequest(`status debe ser uno de: ${allowed.join(", ")}`);
  }

  let newStart: Date | null = null;
  if (body.starts_at !== undefined) {
    newStart = parseIsoWithOffset(body.starts_at);
    if (!newStart) return badRequest("starts_at debe ser ISO con zona horaria");
    if (newStart.getTime() <= Date.now()) return badRequest("starts_at debe ser futuro");
  }
  if (!body.status && !newStart) return badRequest("Nada para actualizar");

  try {
    const appointment = await loadAppointment(id);
    if (!appointment) return notFound();
    if (FINAL_STATUSES.includes(appointment.status)) {
      return Response.json(
        { error: `El turno ya está en estado ${appointment.status}` },
        { status: 409 },
      );
    }

    const db = getSupabaseAdmin();
    const notify = body.notify !== false;
    let notification: NotifyResult | null = null;

    if (newStart) {
      await cancelReminders(id);
      const { error } = await db
        .from("appointments")
        .update({ starts_at: newStart.toISOString(), status: "rescheduled" })
        .eq("id", id);
      if (error) throw error;

      const updated = (await loadAppointment(id))!;
      await planReminders(updated);
      if (notify) notification = await notifyAppointment(updated, "confirmation");
    } else {
      if (body.status !== "confirmed") await cancelReminders(id);
      const { error } = await db.from("appointments").update({ status: body.status }).eq("id", id);
      if (error) throw error;
      if (body.status === "cancelled" && notify) {
        notification = await notifyAppointment(appointment, "cancellation");
      }
    }

    return Response.json({ appointment: await loadAppointment(id), notification });
  } catch (error) {
    return serverError("appointments/:id", error);
  }
}
