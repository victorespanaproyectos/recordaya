/** Envío por canal (WhatsApp hoy; el widget web después). El chatbot solo conoce esta interfaz. */

export interface ChannelButton {
  id: string;
  title: string;
}

export interface SendContext {
  /** Teléfono (WhatsApp) o id de sesión (web). */
  to: string;
  /** Último mensaje del cliente: define si la ventana de atención de 24 h sigue abierta. */
  lastInboundAt: Date | null;
}

export interface SendOutcome {
  /** wamid del mensaje enviado. */
  externalId: string;
}

/** Error de envío: `permanent` = reintentar no sirve (ventana cerrada, número inválido, solicitud rechazada). */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
    public readonly code?: number,
    public readonly reason?: "window_closed" | "rejected" | "rate_limited" | "network",
  ) {
    super(message);
    this.name = "ChannelSendError";
  }
}

export interface ChannelSender {
  sendText(ctx: SendContext, body: string): Promise<SendOutcome>;
  sendButtons(ctx: SendContext, body: string, buttons: ChannelButton[]): Promise<SendOutcome>;
}
