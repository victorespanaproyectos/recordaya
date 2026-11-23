import { z } from "zod";
import { CHATBOT_REPLY_RETRIES } from "@/lib/chatbot/jobs";
import { chatbotActiveFor, createTurnDeps } from "@/lib/chatbot/conversations/turn";
import { runChatbotTurn } from "@/lib/chatbot/engine/orchestrator";
import { log } from "@/lib/logger";
import { verifyQStashSignature } from "@/lib/scheduler/qstash";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 60;

const Body = z.object({ conversationId: z.uuid(), triggerMessageId: z.uuid() });

/**
 * POST /api/jobs/chatbot-reply
 * Lo llama QStash tras agrupar ráfagas (~2,5 s). Body: { conversationId, triggerMessageId }.
 * 200 = listo (enviado u omitido, no se reintenta); 500 = fallo transitorio, QStash reintenta.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!(await verifyQStashSignature(request, raw))) {
    return Response.json({ error: "Firma inválida" }, { status: 401 });
  }
  let parsed;
  try {
    parsed = Body.safeParse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!parsed.success) return Response.json({ error: "Body inválido" }, { status: 400 });
  const { conversationId, triggerMessageId } = parsed.data;

  try {
    // Interruptor global y configuración del negocio: apagados, el turno no se procesa (y no se reintenta).
    const { data: conv } = await getSupabaseAdmin().from("conversations").select("business_id").eq("id", conversationId).maybeSingle();
    if (!conv) return Response.json({ outcome: "skipped", reason: "conversation_not_found" });
    if (!(await chatbotActiveFor(conv.business_id))) return Response.json({ outcome: "skipped", reason: "chatbot_disabled" });

    // QStash informa cuántas veces reintentó este mensaje; en el último intento no se deja al cliente sin respuesta.
    const retried = Number(request.headers.get("upstash-retried") ?? 0);
    const finalAttempt = Number.isFinite(retried) && retried >= CHATBOT_REPLY_RETRIES;
    const result = await runChatbotTurn({ conversationId, triggerMessageId, finalAttempt }, createTurnDeps());
    if (result.outcome === "skipped") return Response.json({ outcome: "skipped", reason: result.reason });
    return Response.json({ outcome: result.delivery.handoffOffer ? "handoff" : "sent" });
  } catch (error) {
    log.error("jobs/chatbot-reply", error, { conversationId, triggerMessageId });
    return Response.json({ error: "Error temporal" }, { status: 500 });
  }
}
