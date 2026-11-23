import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { POST as webhookPost, GET as webhookGet } from "@/app/api/webhooks/whatsapp/route";
import { flushAfter } from "./after";
import { INBOUND_PREFIX, WEBHOOK_MARKER } from "./supabase-test";

let counter = 0;
export const newInboundId = () => `${INBOUND_PREFIX}${++counter}`;

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

export function inboundPayload(opts: {
  from: string;
  text?: string;
  type?: string;
  id?: string;
  contextId?: string;
  /** Número de WhatsApp Business que recibe el mensaje (por defecto, el de la configuración de pruebas). */
  phoneNumberId?: string;
  /** Respuesta a un botón interactivo (p. ej. "handoff:yes"). */
  buttonId?: string;
  profileName?: string;
}) {
  const type = opts.buttonId ? "interactive" : (opts.type ?? "text");
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WEBHOOK_MARKER,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "simulado", phone_number_id: opts.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID },
              contacts: [{ profile: { name: opts.profileName ?? "Cliente Prueba" }, wa_id: opts.from }],
              messages: [
                {
                  from: opts.from,
                  id: opts.id ?? newInboundId(),
                  timestamp: nowSeconds(),
                  type,
                  ...(type === "text" && { text: { body: opts.text ?? "" } }),
                  ...(type === "interactive" && { interactive: { type: "button_reply", button_reply: { id: opts.buttonId, title: opts.text ?? "" } } }),
                  ...(opts.contextId && { context: { from: "simulado", id: opts.contextId } }),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function statusPayload(wamid: string, status: "sent" | "delivered" | "read", to: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WEBHOOK_MARKER,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "simulado", phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID },
              statuses: [{ id: wamid, status, timestamp: nowSeconds(), recipient_id: to }],
            },
          },
        ],
      },
    ],
  };
}

export function sign(rawBody: string, secret = process.env.WHATSAPP_APP_SECRET!) {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** POST firmado al webhook (como Meta) y espera a que termine el procesamiento en after(). */
export async function postWebhook(payload: unknown, opts: { signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = opts.signature === undefined ? sign(raw) : opts.signature;
  if (signature) headers["x-hub-signature-256"] = signature;
  const res = await webhookPost(
    new NextRequest("http://localhost:3000/api/webhooks/whatsapp", { method: "POST", headers, body: raw }),
  );
  await flushAfter();
  return res;
}

export function getWebhook(query: string) {
  return webhookGet(new NextRequest(`http://localhost:3000/api/webhooks/whatsapp?${query}`));
}
