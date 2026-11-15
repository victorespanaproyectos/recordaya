import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { loadAppointment } from "@/lib/appointments/notify";
import { ServiceError, updateAppointment, type StatusUpdate } from "@/lib/appointments/service";
import { parseIsoWithOffset } from "@/lib/dates";
import { badRequest, notFound, readJson, serverError, unauthorized } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  status?: StatusUpdate;
  starts_at?: string;
  notify?: boolean;
}

/**
 * PATCH /api/appointments/:id
 * - { starts_at }            → reprograma y avisa la nueva fecha.
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

  let startsAt: Date | undefined;
  if (body.starts_at !== undefined) {
    const parsed = parseIsoWithOffset(body.starts_at);
    if (!parsed) return badRequest("starts_at debe ser ISO con zona horaria");
    startsAt = parsed;
  }

  try {
    const result = await updateAppointment(id, { status: body.status, startsAt, notify: body.notify });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return serverError("appointments/:id", error);
  }
}
