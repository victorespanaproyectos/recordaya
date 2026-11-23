import { ServiceError } from "@/lib/appointments/service";
import { getCurrentMember } from "@/lib/auth/session";
import { sendAgentMessage } from "@/lib/chatbot/conversations/operator";
import { getConversationDetail } from "@/lib/chatbot/panel-data";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" };

/** GET: línea de tiempo y estado de la conversación (el panel la consulta cada 3 s mientras la pestaña está visible). */
export async function GET(_request: Request, ctx: RouteContext<"/api/panel/conversations/[id]/messages">) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "No autorizado" }, { status: 401, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No encontrada" }, { status: 404, headers: NO_STORE });
  const detail = await getConversationDetail(member.businessId, id);
  if (!detail) return Response.json({ error: "No encontrada" }, { status: 404, headers: NO_STORE });
  return Response.json(detail, { headers: NO_STORE });
}

/** POST { body, clientRequestId }: mensaje del operador asignado. */
export async function POST(request: Request, ctx: RouteContext<"/api/panel/conversations/[id]/messages">) {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "No autorizado" }, { status: 401, headers: NO_STORE });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Origen no permitido" }, { status: 403, headers: NO_STORE });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No encontrada" }, { status: 404, headers: NO_STORE });
  const payload = (await request.json().catch(() => null)) as { body?: unknown; clientRequestId?: unknown } | null;
  try {
    const result = await sendAgentMessage(member, id, String(payload?.body ?? ""), String(payload?.clientRequestId ?? ""));
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ServiceError) return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    console.error("[api/panel/conversations/messages]", error instanceof Error ? error.message : "error");
    return Response.json({ error: "Error temporal" }, { status: 500, headers: NO_STORE });
  }
}
