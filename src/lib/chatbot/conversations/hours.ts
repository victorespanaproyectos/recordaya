import { dayKey, formatHora, zonedToUtc } from "@/lib/dates";

/**
 * Horario de atención humana (`chatbot_settings.human_hours`), siempre en la zona del negocio.
 * Formato: `{ mon: [["09:00","18:00"]], …, exceptions: [{ date: "2026-12-25", closed: true }] }`.
 * Un día sin franjas está cerrado. El fin de cada franja es exclusivo (18:00 ya está cerrado).
 */

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type TimeRange = [start: string, end: string];
export interface HoursException {
  date: string; // YYYY-MM-DD
  closed: true;
}
export type HumanHours = Partial<Record<Weekday, TimeRange[]>> & { exceptions?: HoursException[] };

const LOOKAHEAD_DAYS = 15;

function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayOf(key: string): Weekday {
  const [y, m, d] = key.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Franjas que rigen un día concreto (vacío si es excepción cerrada o no hay franjas). */
function rangesFor(hours: HumanHours, key: string): TimeRange[] {
  if (hours.exceptions?.some((e) => e.date === key && e.closed)) return [];
  return hours[weekdayOf(key)] ?? [];
}

/** ¿Hay atención humana en `now`? */
export function isWithinHumanHours(hours: HumanHours, timeZone: string, now: Date = new Date()): boolean {
  const time = formatHora(now, timeZone); // "HH:MM" (h23): se compara como texto
  return rangesFor(hours, dayKey(now, timeZone)).some(([start, end]) => time >= start && time < end);
}

/**
 * Inicio de la próxima franja que comienza después de `now` (no cuenta la franja en curso).
 * Mira hasta 15 días adelante; `null` si no hay ninguna (horario vacío).
 */
export function nextOpening(hours: HumanHours, timeZone: string, now: Date = new Date()): Date | null {
  const today = dayKey(now, timeZone);
  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const key = addDays(today, i);
    const starts = rangesFor(hours, key)
      .map(([start]) => zonedToUtc(key, start, timeZone))
      .filter((d): d is Date => d !== null && d.getTime() > now.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    if (starts.length > 0) return starts[0];
  }
  return null;
}

/** «hoy a las 15:00» · «mañana a las 9:00» · «el lunes 24 a las 9:00». */
export function describeNextOpening(date: Date, timeZone: string, now: Date = new Date()): string {
  const key = dayKey(date, timeZone);
  const today = dayKey(now, timeZone);
  const time = formatHora(date, timeZone).replace(/^0/, "");
  if (key === today) return `hoy a las ${time}`;
  if (key === addDays(today, 1)) return `mañana a las ${time}`;
  const day = new Intl.DateTimeFormat("es-UY", { weekday: "long", day: "numeric", timeZone }).format(date).replace(",", "");
  return `el ${day} a las ${time}`;
}
