/** Etiquetas y estilos de estados (compartido por Server y Client Components). */

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export const APPOINTMENT_STATUS: Record<string, { label: string; className: string; dot: string }> = {
  scheduled: {
    label: "Programado",
    className: "bg-sky-500/10 text-sky-700 ring-sky-500/20 dark:text-sky-300",
    dot: "bg-sky-500",
  },
  confirmed: {
    label: "Confirmado",
    className: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  rescheduled: {
    label: "Reprogramado",
    className: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
    dot: "bg-amber-500",
  },
  cancelled: {
    label: "Cancelado",
    className: "bg-rose-500/10 text-rose-700 ring-rose-500/20 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  completed: {
    label: "Atendido",
    className: "bg-slate-500/10 text-slate-700 ring-slate-500/20 dark:text-slate-300",
    dot: "bg-slate-500",
  },
  no_show: {
    label: "Ausente",
    className: "bg-orange-500/10 text-orange-700 ring-orange-500/20 dark:text-orange-300",
    dot: "bg-orange-500",
  },
};

export const MESSAGE_KIND: Record<string, string> = {
  reminder_24h: "Recordatorio 24 h",
  reminder_2h: "Recordatorio 2 h",
  confirmation: "Confirmación de reserva",
  cancellation: "Aviso de cancelación",
  reschedule: "Aviso de reprogramación",
  reply: "Respuesta automática",
  test: "Mensaje de prueba",
};

export const MESSAGE_STATUS: Record<string, { label: string; className: string }> = {
  queued: { label: "Programado", className: "text-sky-600 dark:text-sky-300" },
  accepted: { label: "Enviado", className: "text-muted" },
  sent: { label: "Enviado", className: "text-muted" },
  delivered: { label: "Entregado", className: "text-muted" },
  read: { label: "Leído", className: "text-sky-600 dark:text-sky-300" },
  failed: { label: "Falló", className: "text-rose-600 dark:text-rose-300" },
  cancelled: { label: "Cancelado", className: "text-muted line-through" },
};

export const INTENT_LABEL: Record<string, string> = {
  confirm: "Confirmó",
  cancel: "Canceló",
  unknown: "Escribió",
};

/** "59899123456" → "+598 99 123 456" (formato aproximado y legible). */
export function formatPhone(phone: string): string {
  const p = phone.replace(/\D/g, "");
  if (p.startsWith("598") && p.length === 11) return `+598 ${p.slice(3, 5)} ${p.slice(5, 8)} ${p.slice(8)}`;
  return `+${p}`;
}

/** "domingo, 15 de noviembre" → "Domingo, 15 de noviembre". */
export function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export const buttonStyles = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg shadow-sm transition hover:bg-brand-strong active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60",
  secondary:
    "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-medium text-fg transition hover:bg-surface-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-60",
  danger:
    "inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-700 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60",
};

export const inputStyles =
  "w-full rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm text-fg shadow-xs outline-none transition placeholder:text-muted/70 focus:border-brand focus:ring-4 focus:ring-[var(--ring)]";
