import { sendReminder } from "@/lib/appointments/reminders";
import { verifyQStashSignature, type SendReminderJob } from "@/lib/scheduler/qstash";

/**
 * POST /api/jobs/send-reminder
 * Lo llama QStash en la fecha programada. Body: { messageId }.
 * Responder 2xx = listo (no reintenta). 5xx = QStash reintenta.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!(await verifyQStashSignature(request, rawBody))) {
    return Response.json({ error: "Firma inválida" }, { status: 401 });
  }

  let job: Partial<SendReminderJob>;
  try {
    job = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (typeof job.messageId !== "string") {
    return Response.json({ error: "Falta messageId" }, { status: 400 });
  }

  try {
    const result = await sendReminder(job.messageId);
    console.info(`[jobs/send-reminder] ${job.messageId}:`, result);
    return Response.json(result);
  } catch (error) {
    console.error(`[jobs/send-reminder] ${job.messageId} falló, QStash reintentará:`, error);
    return Response.json({ error: "Error temporal" }, { status: 500 });
  }
}
