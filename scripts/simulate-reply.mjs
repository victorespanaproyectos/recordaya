/**
 * Simula que un cliente responde por WhatsApp, enviando al webhook LOCAL un evento
 * firmado igual que lo firma Meta. Sirve para probar confirmar/cancelar en desarrollo,
 * ya que las respuestas reales siempre llegan al webhook de producción.
 *
 * Uso:
 *   npm run simulate:reply -- <teléfono> <texto>
 *   npm run simulate:reply -- 59899123456 1
 *   npm run simulate:reply -- 59899123456 "No puedo, cancelo"
 *
 * Variables: WHATSAPP_APP_SECRET (de .env.local) y opcionalmente APP_URL (por defecto http://localhost:3000).
 */
import { createHmac } from "node:crypto";

const [phone, ...words] = process.argv.slice(2);
const text = words.join(" ");

if (!phone || !text) {
  console.error('Uso: npm run simulate:reply -- <teléfono> <texto>   (ej. 59899123456 1)');
  process.exit(1);
}

const secret = process.env.WHATSAPP_APP_SECRET;
if (!secret) {
  console.error("Falta WHATSAPP_APP_SECRET en .env.local");
  process.exit(1);
}

const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(appUrl)) {
  console.error(`APP_URL apunta a ${appUrl}: este script solo se usa contra el servidor local.`);
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const from = phone.replace(/\D/g, "");
const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "simulado",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "simulado", phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "" },
            contacts: [{ profile: { name: "Simulado" }, wa_id: from }],
            messages: [{ from, id: `wamid.SIMULADO.${now}.${Math.random().toString(36).slice(2, 8)}`, timestamp: String(now), type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
};

const body = JSON.stringify(payload);
const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

const res = await fetch(`${appUrl}/api/webhooks/whatsapp`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature-256": signature },
  body,
});

console.log(`→ ${from}: "${text}"  ·  webhook respondió ${res.status} ${await res.text()}`);
console.log("Revisa el panel local en unos segundos (se procesa en segundo plano).");
