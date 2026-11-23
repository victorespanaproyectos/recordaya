/**
 * Simula que un cliente escribe por WhatsApp, enviando al webhook LOCAL un evento firmado igual que lo firma Meta.
 * Sirve para probar confirmar/cancelar y el chatbot en desarrollo (las respuestas reales llegan al webhook de producción).
 *
 * Uso:
 *   npm run simulate:reply -- <teléfono> <texto> [opciones]
 *   npm run simulate:reply -- 59899123456 1
 *   npm run simulate:reply -- 59899123456 "No puedo, cancelo"
 *   npm run simulate:reply -- 59899123456 "1" --context wamid.XXXX            (responde citando un recordatorio)
 *   npm run simulate:reply -- 59899123456 "Sí, con una persona" --button handoff:yes
 *   npm run simulate:reply -- 59899123456 --type audio                          (audio, imagen, sticker…: sin texto)
 *   npm run simulate:reply -- 59899123456 "hola" --phone-number-id <id> --name "María"
 *
 * Opciones:
 *   --context <wamid>          cita un mensaje nuestro (el id sale de la tabla messages o conversation_messages)
 *   --button <id>              respuesta a un botón interactivo (handoff:yes / handoff:no)
 *   --type <tipo>              tipo de mensaje distinto de texto (audio, image, video, document, sticker, location)
 *   --phone-number-id <id>     número de WhatsApp Business que recibe (por defecto WHATSAPP_PHONE_NUMBER_ID);
 *                              para que el chatbot responda debe coincidir con businesses.wa_phone_number_id
 *   --name <nombre>            nombre del perfil de WhatsApp del cliente
 *
 * Variables: WHATSAPP_APP_SECRET (de .env.local) y opcionalmente APP_URL (por defecto http://localhost:3000).
 */
import { createHmac } from "node:crypto";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      flags[key] = argv[i + 1];
      i++;
    } else positional.push(argv[i]);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const [phone, ...words] = positional;
const text = words.join(" ");
const type = flags.type ?? (flags.button ? "interactive" : "text");

if (!phone || (!text && type === "text")) {
  console.error('Uso: npm run simulate:reply -- <teléfono> <texto> [--context <wamid>] [--button <id>] [--type audio] [--phone-number-id <id>] [--name <nombre>]');
  process.exit(1);
}
if (flags.button && !/^[\w:.-]{1,200}$/.test(flags.button)) {
  console.error("El id del botón solo admite letras, números y : . _ -");
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
            metadata: { display_phone_number: "simulado", phone_number_id: flags["phone-number-id"] ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? "" },
            contacts: [{ profile: { name: flags.name ?? "Simulado" }, wa_id: from }],
            messages: [
              {
                from,
                id: `wamid.SIMULADO.${now}.${Math.random().toString(36).slice(2, 8)}`,
                timestamp: String(now),
                type,
                ...(type === "text" && { text: { body: text } }),
                ...(type === "interactive" && { interactive: { type: "button_reply", button_reply: { id: flags.button, title: text || flags.button } } }),
                ...(flags.context && { context: { from: "simulado", id: flags.context } }),
              },
            ],
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

console.log(`→ ${from}: ${type === "text" ? `"${text}"` : `[${type}${flags.button ? ` ${flags.button}` : ""}]`}  ·  webhook respondió ${res.status} ${await res.text()}`);
console.log("Revisa el panel local en unos segundos (se procesa en segundo plano).");
