export const TYPE_LABEL: Record<string, string> = { faq: "Pregunta frecuente", text: "Texto", file: "Archivo", url: "Página web" };

export const CATEGORY_LABEL: Record<string, string> = {
  products_services: "Productos y servicios",
  policies: "Políticas",
  hours: "Horarios",
  contact: "Contacto",
  faq: "Preguntas frecuentes",
  other: "Otro",
};

export const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  pending: { label: "En cola", className: "bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  processing: { label: "Procesando", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  ready: { label: "Listo", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  failed: { label: "Con error", className: "bg-rose-500/10 text-rose-700 dark:text-rose-300" },
  disabled: { label: "Desactivada", className: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
};

/** Mensaje legible del último error guardado (jsonb `{ message }`). */
export function errorMessage(lastError: unknown): string | null {
  if (lastError && typeof lastError === "object" && "message" in lastError) return String((lastError as { message: unknown }).message);
  return null;
}
