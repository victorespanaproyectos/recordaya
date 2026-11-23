/**
 * Logger estructurado (JSON por línea) para el módulo de chatbot.
 * Nunca serializa el texto de los clientes ni teléfonos completos (RNF-09, RNF-10).
 */

type Level = "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

/** Claves que jamás se escriben en los logs, aunque se pasen por error. */
const FORBIDDEN_KEYS = new Set(["body", "text", "message_body", "payload", "phone", "to", "from"]);

/** "59899123456" → "5989****456": deja el prefijo de país y los 3 últimos dígitos. */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length <= 7) return "*".repeat(digits.length);
  return `${digits.slice(0, 4)}${"*".repeat(digits.length - 7)}${digits.slice(-3)}`;
}

function sanitize(ctx: LogContext | undefined): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(ctx ?? {})) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function errorInfo(error: unknown): LogContext {
  if (error instanceof Error) return { errorName: error.name, error: error.message };
  return { error: String(error) };
}

function write(level: Level, scope: string, msg: string, ctx: LogContext) {
  const line = JSON.stringify({ level, scope, msg, ts: new Date().toISOString(), ...ctx });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info(scope: string, msg: string, ctx?: LogContext) {
    write("info", scope, msg, sanitize(ctx));
  },
  warn(scope: string, msg: string, ctx?: LogContext) {
    write("warn", scope, msg, sanitize(ctx));
  },
  /** `msgOrError` puede ser un texto o un Error (se registra su nombre y mensaje, sin stack). */
  error(scope: string, msgOrError: string | unknown, ctx?: LogContext) {
    const isText = typeof msgOrError === "string";
    write("error", scope, isText ? msgOrError : "error", {
      ...(isText ? {} : errorInfo(msgOrError)),
      ...sanitize(ctx),
    });
  },
};
