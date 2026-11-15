import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifica la cabecera X-Hub-Signature-256 que Meta envía en cada webhook.
 * Firma = HMAC-SHA256 del cuerpo crudo usando la clave secreta de la app.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const received = signatureHeader.slice("sha256=".length);

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Tipos del payload (solo los campos que usamos) ──────────

export type WaMessageStatus = "sent" | "delivered" | "read" | "failed";

export interface WaStatusUpdate {
  id: string; // wamid del mensaje que enviamos
  status: WaMessageStatus;
  timestamp: string; // segundos Unix como string
  recipient_id: string;
  errors?: { code: number; title: string; message?: string; error_data?: { details?: string } }[];
}

export interface WaIncomingMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  button?: { text: string; payload: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  context?: { from: string; id: string }; // presente si responde a un mensaje nuestro
}

export interface WaWebhookValue {
  messaging_product: "whatsapp";
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: { profile: { name: string }; wa_id: string }[];
  statuses?: WaStatusUpdate[];
  messages?: WaIncomingMessage[];
}

export interface WaWebhookPayload {
  object: string;
  entry: { id: string; changes: { field: string; value: WaWebhookValue }[] }[];
}

/** Texto legible de un mensaje entrante (texto, botón de plantilla o respuesta interactiva). */
export function incomingText(msg: WaIncomingMessage): string | null {
  return (
    msg.text?.body ??
    msg.button?.text ??
    msg.interactive?.button_reply?.title ??
    msg.interactive?.list_reply?.title ??
    null
  );
}
