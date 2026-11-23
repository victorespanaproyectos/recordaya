export interface TemplateVars {
  negocio?: string;
  asistente?: string;
  proximo_horario?: string;
}

/** Sustituye `{negocio}`, `{asistente}` y `{proximo_horario}`. Una sola pasada; lo desconocido queda igual. */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{(negocio|asistente|proximo_horario)\}/g, (whole, key: keyof TemplateVars) => vars[key] ?? whole);
}
