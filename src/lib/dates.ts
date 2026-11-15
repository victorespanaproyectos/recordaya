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
export const DAY_MS = 24 * HOUR_MS;

/** Partes de una fecha vistas en una zona horaria. */
function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** Diferencia (ms) entre la hora local de `timeZone` y UTC en ese instante. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - (date.getTime() - date.getMilliseconds());
}

/** "2026-11-17" + "15:30" en America/Montevideo → instante UTC correspondiente. */
export function zonedToUtc(day: string, time: string, timeZone: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const tm = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dm || !tm) return null;
  const naive = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
  let guess = naive - offsetMs(new Date(naive), timeZone);
  guess = naive - offsetMs(new Date(guess), timeZone); // corrige cerca de cambios de horario
  return new Date(guess);
}

/** Clave de día "YYYY-MM-DD" en la zona del negocio. */
export function dayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Inicio del día (00:00 local) en UTC. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  return zonedToUtc(dayKey(date, timeZone), "00:00", timeZone)!;
}

/** "Hoy", "Mañana", "Ayer" o "jueves 20 de noviembre". */
export function relativeDayLabel(date: Date, timeZone: string, now = new Date()): string {
  const key = dayKey(date, timeZone);
  if (key === dayKey(now, timeZone)) return "Hoy";
  if (key === dayKey(new Date(now.getTime() + DAY_MS), timeZone)) return "Mañana";
  if (key === dayKey(new Date(now.getTime() - DAY_MS), timeZone)) return "Ayer";
  return formatFecha(date, timeZone);
}

/** "hace 5 min", "hace 2 h", "hace 3 d". */
export function timeAgo(date: Date, now = new Date()): string {
  const s = Math.round((now.getTime() - date.getTime()) / 1000);
  if (s < 60) return "recién";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}
