import "server-only";
import { ChannelSendError, type ChannelSender } from "@/lib/chatbot/channels/types";
import { whatsappChannel } from "@/lib/chatbot/channels/whatsapp";
import type { Contact } from "./contacts";
import { logEvent } from "./events";
import { appendOutbound, markOutboundFailed, markOutboundSent, type Conversation } from "./service";

export const HANDOFF_BUTTONS = [
  { id: "handoff:yes", title: "Sí, con una persona" },
  { id: "handoff:no", title: "No, sigo aquí" },
];
/** Si los botones no se pueden enviar, se pide por texto (05 §16.3). */
export const HANDOFF_TEXT_FALLBACK = "Responde *persona* para hablar con alguien del equipo.";

export interface SendReplyInput {
  text: string;
  buttons?: boolean;
  senderType: "bot" | "system";
  replyToMessageId?: string | null;
  ai?: Record<string, unknown> | null;
  /** Último mensaje del cliente (ventana de 24 h). */
  lastInboundAt: Date | null;
  channel?: ChannelSender;
}

export type SendReplyResult = { status: "sent"; messageId: string } | { status: "duplicate"; messageId: string } | { status: "failed"; messageId: string; reason: string };

/**
 * Envía una respuesta del bot/sistema: la registra como `queued` ANTES de enviar (idempotencia), envía por el canal
 * y la actualiza. Un fallo permanente (ventana cerrada, rechazo) deja el mensaje `failed` y NO se reintenta;
 * uno transitorio se relanza para que el job se reintente (la fila `queued` se reutiliza, no se duplica).
 */
export async function sendReply(conversation: Conversation, contact: Contact, input: SendReplyInput): Promise<SendReplyResult> {
  const channel = input.channel ?? whatsappChannel;
  const ref = await appendOutbound(conversation, {
    senderType: input.senderType,
    body: input.text,
    replyToMessageId: input.replyToMessageId,
    ai: input.ai,
    contentType: input.buttons ? "interactive" : "text",
  });
  if (ref.duplicate && ref.existing && ref.existing.status !== "queued") return { status: "duplicate", messageId: ref.id };

  const body = ref.existing?.body ?? input.text;
  const to = { to: contact.externalId, lastInboundAt: input.lastInboundAt };
  try {
    let outcome;
    if (input.buttons) {
      try {
        outcome = await channel.sendButtons(to, body, HANDOFF_BUTTONS);
      } catch (error) {
        // Sin botones (p. ej. el canal no los admite): se pide por texto en vez de dejar al cliente sin opción.
        if (!(error instanceof ChannelSendError) || error.reason === "window_closed" || !error.permanent) throw error;
        outcome = await channel.sendText(to, `${body}\n\n${HANDOFF_TEXT_FALLBACK}`);
      }
    } else {
      outcome = await channel.sendText(to, body);
    }
    await markOutboundSent(ref.id, outcome.externalId);
    return { status: "sent", messageId: ref.id };
  } catch (error) {
    if (error instanceof ChannelSendError && error.permanent) {
      await markOutboundFailed(ref.id, error);
      await logEvent({ conversationId: conversation.id, businessId: conversation.businessId, type: "send_failed", payload: { reason: error.reason ?? "rejected", code: error.code ?? null } });
      return { status: "failed", messageId: ref.id, reason: error.message };
    }
    throw error; // transitorio: el job devuelve 500 y QStash reintenta
  }
}
