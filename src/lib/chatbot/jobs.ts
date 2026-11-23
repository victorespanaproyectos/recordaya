import "server-only";
import { publishJob } from "@/lib/scheduler/qstash";

/** Rutas de los jobs del chatbot (02 §Jobs). Los handlers llegan en sus propias tareas. */
export const CHATBOT_REPLY_PATH = "/api/jobs/chatbot-reply";
export const KNOWLEDGE_INGEST_PATH = "/api/jobs/knowledge-ingest";
export const CONVERSATIONS_MAINTENANCE_PATH = "/api/jobs/conversations-maintenance";

/** Reintentos de QStash para un turno de IA; en el último, el job responde con el mensaje de respaldo. */
export const CHATBOT_REPLY_RETRIES = 3;

/** Agrupa ráfagas: el turno de IA espera unos segundos por si el cliente sigue escribiendo (06 §13.1). */
const REPLY_DELAY_SECONDS = 2.5;

/** Encola un turno de IA. Un mismo mensaje entrante (`waMessageId`) se encola una sola vez. */
export function enqueueChatbotReply(input: {
  conversationId: string;
  triggerMessageId: string;
  waMessageId: string;
}): Promise<string> {
  return publishJob(
    CHATBOT_REPLY_PATH,
    { conversationId: input.conversationId, triggerMessageId: input.triggerMessageId },
    { delaySeconds: REPLY_DELAY_SECONDS, deduplicationId: `chat-${input.waMessageId}`, retries: CHATBOT_REPLY_RETRIES },
  );
}

/** Encola el procesamiento de una versión de documento de conocimiento. */
export function enqueueIngest(documentId: string, attempt = 0): Promise<string> {
  return publishJob(
    KNOWLEDGE_INGEST_PATH,
    { documentId },
    { deduplicationId: `ingest-${documentId}-${attempt}`, retries: 3 },
  );
}
