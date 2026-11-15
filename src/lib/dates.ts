/** Formato de fechas para los mensajes, siempre en la zona horaria del negocio. */

const LOCALE = "es-UY";

/** "lunes 17 de noviembre" */
export function formatFecha(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone,
  })
    .format(date)
    .replace(",", "");
}

/** "15:30" */
export function formatHora(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
}

/** Acepta solo fechas ISO con zona horaria explícita ("Z" o "-03:00") para evitar ambigüedad. */
export function parseIsoWithOffset(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const HOUR_MS = 60 * 60 * 1000;
