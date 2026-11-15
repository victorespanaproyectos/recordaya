import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { scheduleIfDue } from "@/lib/appointments/reminders";
import { maxDelayMs, verifyQStashSignature } from "@/lib/scheduler/qstash";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * POST /api/jobs/dispatch
 * Red de seguridad, pensado para un Schedule de QStash (ej. cada hora):
 * programa los recordatorios "queued" sin schedule_id que ya entran en la demora máxima
 * (turnos reservados con mucha anticipación, o fallos al programar).
 * Acepta firma de QStash o Authorization: Bearer <ADMIN_API_KEY> (para dispararlo a mano).
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const authorized =
    isAuthorizedAdmin(request) || (await verifyQStashSignature(request, rawBody));
  if (!authorized) return Response.json({ error: "No autorizado" }, { status: 401 });

  const horizon = new Date(Date.now() + maxDelayMs()).toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("messages")
    .select("id, scheduled_for")
    .eq("status", "queued")
    .is("schedule_id", null)
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", horizon)
    .order("scheduled_for")
    .limit(200);

  if (error) {
    console.error("[jobs/dispatch]", error);
    return Response.json({ error: "Error al leer mensajes" }, { status: 500 });
  }

  let scheduled = 0;
  const failures: string[] = [];
  for (const message of data) {
    // Si ya se pasó la hora (ej. QStash caído), se envía lo antes posible.
    const sendAt = new Date(Math.max(new Date(message.scheduled_for).getTime(), Date.now()));
    try {
      if (await scheduleIfDue(message.id, sendAt)) scheduled++;
    } catch (err) {
      console.error(`[jobs/dispatch] No se pudo programar ${message.id}:`, err);
      failures.push(message.id);
    }
  }

  return Response.json({ pending: data.length, scheduled, failures });
}
