/**
 * Error permanente de extracción: el mensaje se muestra tal cual en el panel (en español, accionable).
 * Reintentar el mismo contenido no lo arregla.
 */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MIN_CHARS_PER_PAGE = 50;
export const MAX_PAGES = 300;
