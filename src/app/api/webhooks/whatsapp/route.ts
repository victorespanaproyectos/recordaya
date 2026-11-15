import { after, type NextRequest } from "next/server";
import { processWebhook } from "@/lib/whatsapp/process-webhook";
import { verifyWebhookSignature, type WaWebhookPayload } from "@/lib/whatsapp/webhook";

/**
 * GET: verificación inicial del webhook desde Meta for Developers.
 * Meta llama con hub.mode=subscribe, hub.verify_token y hub.challenge.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const expectedToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (
    expectedToken &&
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === expectedToken
  ) {
    return new Response(params.get("hub.challenge") ?? "", { status: 200 });
  }

  return new Response("Forbidden", { status: 403 });
}

/**
 * POST: eventos de WhatsApp (estados de mensajes y mensajes entrantes).
 * Respondemos 200 enseguida y procesamos después con after(), porque Meta
 * reintenta si tardamos demasiado.
 */
export async function POST(request: NextRequest) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const rawBody = await request.text();

  if (
    !appSecret ||
    !verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"), appSecret)
  ) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: WaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WaWebhookPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  after(async () => {
    try {
      await processWebhook(payload);
    } catch (error) {
      console.error("[webhook] Error procesando evento:", error);
    }
  });

  return new Response("OK", { status: 200 });
}
