import type { TemplateParam } from "./client";

/**
 * Plantillas aprobadas en WhatsApp Manager (idioma "es", variables posicionales).
 * El orden de cada builder = orden de {{1}}, {{2}}... en la plantilla.
 */
export const TEMPLATES = {
  /** Recordatorio 24 h / 2 h. Pide responder 1 (confirmar) o 2 (cancelar). */
  recordatorio: "event_details_reminder_2",
  /** Confirmación al reservar el turno. */
  confirmacion: "appointment_confirmation_1",
  /** Recordatorio para turnos ya confirmados. */
  recordatorioConfirmado: "event_details_reminder_1",
  /** Aviso de turno cancelado. */
  cancelacion: "appointment_cancellation_1",
  /** El cliente no asistió: invitación a reprogramar. */
  reprogramar: "reprogramar",
} as const;

export type TemplateKey = keyof typeof TEMPLATES;

const params = (pairs: [string, string][]): TemplateParam[] =>
  pairs.map(([name, value]) => ({ name, value }));

// ── event_details_reminder_2 ────────────────────────────────
// "Hola {{1}}, te recordamos tu turno del {{2}} a las {{3}} en {{4}}.
//  Respondé 1 para confirmar o 2 para cancelar."
export interface RecordatorioVars {
  nombre: string;
  fecha: string;
  hora: string;
  negocio: string;
}
export const recordatorioParams = (v: RecordatorioVars) =>
  params([["nombre", v.nombre], ["fecha", v.fecha], ["hora", v.hora], ["negocio", v.negocio]]);

// ── appointment_confirmation_1 ──────────────────────────────
// "Hola {{1}}, Gracias por reservar con {{2}}.
//  Se confirma su cita para {{3}} el {{4}} a las {{5}}."
export interface ConfirmacionVars {
  nombre: string;
  negocio: string;
  servicio: string;
  fecha: string;
  hora: string;
}
export const confirmacionParams = (v: ConfirmacionVars) =>
  params([
    ["nombre", v.nombre],
    ["negocio", v.negocio],
    ["servicio", v.servicio],
    ["fecha", v.fecha],
    ["hora", v.hora],
  ]);

// ── event_details_reminder_1 ────────────────────────────────
// "Recordatorio: has confirmado tu asistencia a {{1}} por {{2}}.
//  Tu cita es el {{3}} a las {{4}} en {{5}}."
export interface RecordatorioConfirmadoVars {
  servicio: string;
  negocio: string;
  fecha: string;
  hora: string;
  direccion: string;
}
export const recordatorioConfirmadoParams = (v: RecordatorioConfirmadoVars) =>
  params([
    ["servicio", v.servicio],
    ["negocio", v.negocio],
    ["fecha", v.fecha],
    ["hora", v.hora],
    ["direccion", v.direccion],
  ]);

// ── appointment_cancellation_1 ──────────────────────────────
// "Hola {{1}}, Tu próxima cita con {{2}} el {{3}} a las {{4}} ha sido cancelada."
export interface CancelacionVars {
  nombre: string;
  negocio: string;
  fecha: string;
  hora: string;
}
export const cancelacionParams = (v: CancelacionVars) =>
  params([["nombre", v.nombre], ["negocio", v.negocio], ["fecha", v.fecha], ["hora", v.hora]]);

// ── reprogramar ─────────────────────────────────────────────
// "Hola {{1}}, te echamos de menos en tu cita programada {{2}} el {{3}}.
//  Por favor, responda para reprogramar o póngase en contacto con {{4}}..."
export interface ReprogramarVars {
  nombre: string;
  servicio: string;
  fecha: string;
  negocio: string;
}
export const reprogramarParams = (v: ReprogramarVars) =>
  params([["nombre", v.nombre], ["servicio", v.servicio], ["fecha", v.fecha], ["negocio", v.negocio]]);
