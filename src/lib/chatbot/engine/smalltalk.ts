/** Atajos sin IA (04 §14.1 paso 3): saludo, gracias, despedida y contenido que no es texto. */

export type Shortcut = "greeting" | "thanks" | "farewell" | "non_text" | "none";

export const NON_TEXT_TYPES = new Set(["image", "audio", "voice", "video", "document", "sticker", "location", "contacts", "contact", "unsupported"]);

const GREETINGS = new Set([
  "hola", "holaa", "hola buenas", "buenas", "buen dia", "buenos dias", "buenas tardes", "buenas noches", "hey", "hi", "hello",
  "que tal", "hola que tal", "hola como estas", "como estas", "como va", "ola", "holis", "saludos",
]);
const THANKS = new Set([
  "gracias", "muchas gracias", "mil gracias", "ok gracias", "okey gracias", "perfecto gracias", "genial gracias", "dale gracias",
  "gracias por todo", "muchisimas gracias", "muchas gracias por todo", "gracias igualmente", "thanks", "thank you", "buenisimo gracias",
]); // "ok", "dale", "listo"… solos NO: pueden ser la respuesta a una pregunta del asistente y deben pasar por la IA.
const FAREWELLS = new Set(["chau", "chao", "adios", "hasta luego", "hasta pronto", "nos vemos", "bye", "hasta mañana", "hasta manana", "que tengas buen dia", "saludos cordiales"]);

/** Solo emojis de agradecimiento / conformidad. */
const EMOJI_THANKS = /^[\s👍🙏😊😀😁🙂👌✅💪❤️♥️🤝🙌👏]+$/u;

/** Minúsculas, sin tildes, sin signos y con letras repetidas colapsadas ("gracias!!" → "gracias", "holaaa" → "hola"). */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/(\p{L})\1{2,}/gu, "$1$1") // "holaaaa" → "holaa"
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyShortcut(message: { contentType?: string | null; text?: string | null }): Shortcut {
  if (message.contentType && NON_TEXT_TYPES.has(message.contentType)) return "non_text";
  const raw = message.text?.trim() ?? "";
  if (!raw) return "none";
  if (EMOJI_THANKS.test(raw)) return "thanks";

  const n = normalize(raw).replace(/(\p{L})\1+\b/gu, "$1");
  const compact = (set: Set<string>) => [...set].map((s) => s.replace(/(\p{L})\1+\b/gu, "$1"));
  // Se comparan las formas con la última letra repetida ya reducida ("holaa" y "hola" coinciden).
  if (compact(GREETINGS).includes(n)) return "greeting";
  if (compact(THANKS).includes(n)) return "thanks";
  if (compact(FAREWELLS).includes(n)) return "farewell";
  return "none";
}

export const THANKS_REPLY = "¡De nada! Si necesitas algo más, aquí estoy.";
export const FAREWELL_REPLY = "¡Hasta pronto! Que tengas un buen día.";

/** Respuesta del atajo con los mensajes configurados del negocio. `null` si no hay atajo. */
export function shortcutReply(
  shortcut: Shortcut,
  messages: { welcome: string; unsupported: string; closing: string | null },
): string | null {
  switch (shortcut) {
    case "greeting":
      return messages.welcome;
    case "thanks":
      return THANKS_REPLY;
    case "farewell":
      return messages.closing ?? FAREWELL_REPLY;
    case "non_text":
      return messages.unsupported;
    default:
      return null;
  }
}
