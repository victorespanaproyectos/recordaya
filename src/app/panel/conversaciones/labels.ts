export const CONVERSATION_STATUS: Record<string, { label: string; className: string }> = {
  bot: { label: "IA", className: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300" },
  pending_human: { label: "Pendiente", className: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300" },
  human: { label: "Humano", className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" },
  resolved: { label: "Resuelta", className: "bg-slate-500/10 text-slate-700 ring-slate-500/20 dark:text-slate-300" },
  closed: { label: "Cerrada", className: "bg-slate-500/5 text-muted ring-border" },
};

/** Motivo por el que una conversación pasó a una persona. */
export const HANDOFF_REASON: Record<string, string> = {
  customer_request: "El cliente pidió hablar con una persona",
  no_information: "El asistente no encontró información para responder",
  low_confidence: "El asistente no estaba seguro de la respuesta",
  unsupported_content: "El cliente envió contenido que el asistente no puede leer",
  sensitive_topic: "El tema requiere atención de una persona (queja, pago o dato sensible)",
  operator_initiated: "La derivó una persona del equipo",
  budget_exhausted: "Se alcanzó el tope de gasto de IA del mes",
};

export const EVENT_LABEL: Record<string, string> = {
  opened: "Conversación iniciada",
  status_changed: "Cambio de estado",
  handoff_offered: "El asistente ofreció una persona",
  handoff_accepted: "El cliente aceptó hablar con una persona",
  handoff_declined: "El cliente prefirió seguir con el asistente",
  claimed: "Tomada por",
  released: "Liberada: vuelve a la cola",
  returned_to_bot: "Devuelta al asistente",
  resolved: "Resuelta",
  closed: "Cerrada",
  reopened: "Reabierta por un mensaje nuevo",
  reminder_reply_routed: "Respuesta a un recordatorio (se procesó como siempre)",
  send_failed: "No se pudo enviar un mensaje",
  budget_exhausted: "Tope de gasto de IA alcanzado",
  injection_suspected: "Posible intento de manipular al asistente",
  rate_limited: "Demasiados mensajes seguidos",
};

export const REMINDER_LABEL: Record<string, string> = {
  reminder_24h: "Recordatorio 24 h",
  reminder_2h: "Recordatorio 2 h",
  confirmation: "Confirmación de reserva",
  reschedule: "Aviso de reprogramación",
  cancellation: "Aviso de cancelación",
  test: "Mensaje de prueba",
};

export const TABS = [
  { id: "pending", label: "Pendientes" },
  { id: "mine", label: "Mías" },
  { id: "ai", label: "IA" },
  { id: "all", label: "Todas" },
  { id: "closed", label: "Cerradas" },
] as const;
