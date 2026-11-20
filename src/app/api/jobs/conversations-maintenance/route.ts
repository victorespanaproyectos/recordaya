import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { runMaintenance } from "@/lib/chatbot/conversations/maintenance";
import { log } from "@/lib/logger";
import { verifyQStashSignature } from "@/lib/scheduler/qstash";

export const maxDuration = 60;

/**
 * POST /api/jobs/conversations-maintenance
 * Pensado para un Schedule de QStash cada 10 minutos (`*​/10 * * * *`). Acepta la firma de QStash o
 * `Authorization: Bearer <ADMIN_API_KEY>` (para dispararlo a mano). Responde { resolved, closed, requeued, unavailable, purged }.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const authorized = isAuthorizedAdmin(request) || (await verifyQStashSignature(request, raw));
  if (!authorized) return Response.json({ error: "No autorizado" }, { status: 401 });
  try {
    return Response.json(await runMaintenance());
  } catch (error) {
    log.error("jobs/conversations-maintenance", error);
    return Response.json({ error: "Error temporal" }, { status: 500 });
  }
}
