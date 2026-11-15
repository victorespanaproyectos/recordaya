/** Interpreta la respuesta del cliente a un recordatorio (sin dependencias, fácil de probar). */

export type ReplyIntent = "confirm" | "cancel" | "unknown";

const CONFIRM_WORDS = new Set(["1", "si", "confirmo", "confirmar", "confirmado", "ok", "dale", "voy"]);
const CANCEL_WORDS = new Set(["2", "no", "cancelo", "cancelar", "cancelado", "cancela"]);

/** "1", "Sí!", "1 confirmo", "Confirmar" → confirm · "2", "no puedo", "Cancelar" → cancel. */
export function parseReplyIntent(text: string | null): ReplyIntent {
  if (!text) return "unknown";
  const normalized = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes: "sí" → "si"
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim();
  const first = normalized.split(/\s+/)[0] ?? "";
  if (CONFIRM_WORDS.has(first)) return "confirm";
  if (CANCEL_WORDS.has(first)) return "cancel";
  return "unknown";
}
