import "server-only";
import { sendInteractiveButtons, sendText, WhatsAppApiError } from "@/lib/whatsapp/client";
import { ChannelSendError, type ChannelButton, type ChannelSender, type SendContext, type SendOutcome } from "./types";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Códigos de la Cloud API que indican un problema pasajero (límites de envío o del servicio), no del mensaje. */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131048, 131056]);

function assertWindowOpen(ctx: SendContext, now = Date.now()) {
  if (!ctx.lastInboundAt || now - ctx.lastInboundAt.getTime() > SERVICE_WINDOW_MS) {
    throw new ChannelSendError("Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite plantillas", true, undefined, "window_closed");
  }
}

/** Traduce un error de la Cloud API a permanente (no reintentar) o transitorio (reintentar). */
export function mapSendError(error: unknown): ChannelSendError {
  if (error instanceof ChannelSendError) return error;
  if (error instanceof WhatsAppApiError) {
    if (error.code === 131047) return new ChannelSendError("Fuera de la ventana de 24 horas", true, error.code, "window_closed");
    if (error.httpStatus === 429 || error.httpStatus >= 500 || (error.code !== undefined && TRANSIENT_CODES.has(error.code))) {
      return new ChannelSendError("WhatsApp no pudo procesar el envío ahora", false, error.code, error.httpStatus === 429 ? "rate_limited" : "network");
    }
    return new ChannelSendError(error.message, true, error.code, "rejected");
  }
  return new ChannelSendError("No se pudo conectar con WhatsApp", false, undefined, "network");
}

export const whatsappChannel: ChannelSender = {
  async sendText(ctx: SendContext, body: string): Promise<SendOutcome> {
    assertWindowOpen(ctx);
    try {
      return { externalId: (await sendText(ctx.to, body)).messageId };
    } catch (error) {
      throw mapSendError(error);
    }
  },

  async sendButtons(ctx: SendContext, body: string, buttons: ChannelButton[]): Promise<SendOutcome> {
    assertWindowOpen(ctx);
    try {
      return { externalId: (await sendInteractiveButtons(ctx.to, body, buttons)).messageId };
    } catch (error) {
      throw mapSendError(error);
    }
  },
};
