/**
 * Parser estricto de confirmar/cancelar (02 §5.1). Solo se usa con el chatbot activo, para decidir si un mensaje
 * SIN cita es realmente una respuesta a un recordatorio. No modifica `appointments/intent.ts`.
 *
 * Devuelve `confirm`/`cancel` solo si el mensaje completo tiene ≤ 3 palabras y TODAS pertenecen al vocabulario
 * de una misma intención; cualquier otra cosa es `unknown` y va al chatbot.
 */

export type StrictIntent = "confirm" | "cancel" | "unknown";

const CONFIRM_WORDS = new Set(["1", "si", "confirmo", "confirmar", "confirmado", "ok", "dale", "voy", "gracias"]);
const CANCEL_WORDS = new Set(["2", "no", "cancelo", "cancelar", "cancelado", "cancela", "puedo"]);
const MAX_WORDS = 3;

export function parseStrictReplyIntent(text: string | null | undefined): StrictIntent {
  if (!text) return "unknown";
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return "unknown";

  if (words.every((w) => CONFIRM_WORDS.has(w))) return "confirm";
  if (words.every((w) => CANCEL_WORDS.has(w))) return "cancel";
  return "unknown";
}
