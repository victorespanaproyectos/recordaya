import { normalizeText } from "../normalize";
import { extractDocx } from "./docx";
import { ExtractionError } from "./errors";
import { extractPdf } from "./pdf";
import { extractTxt } from "./txt";
import { extractUrl, type UrlOptions } from "./url";

export { ExtractionError } from "./errors";

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const TXT_MIME = "text/plain";
export const ALLOWED_FILE_MIMES = [PDF_MIME, DOCX_MIME, TXT_MIME] as const;

export type ExtractInput =
  | { kind: "file"; bytes: Uint8Array; mimeType: string }
  | { kind: "url"; url: string; options?: UrlOptions };

export interface Extracted {
  /** Texto ya normalizado, listo para fragmentar. */
  text: string;
  pages?: number;
}

/** Extrae y normaliza el texto de un archivo o una URL. Lanza `ExtractionError` con un mensaje legible. */
export async function extractContent(input: ExtractInput): Promise<Extracted> {
  let result: Extracted;
  if (input.kind === "url") {
    const { text } = await extractUrl(input.url, input.options);
    result = { text: normalizeText(text) };
  } else if (input.mimeType === PDF_MIME) {
    const { text, pages } = await extractPdf(input.bytes);
    result = { text, pages }; // ya normalizado por páginas
  } else if (input.mimeType === DOCX_MIME) {
    result = { text: normalizeText(await extractDocx(input.bytes)) };
  } else if (input.mimeType === TXT_MIME) {
    result = { text: normalizeText(extractTxt(input.bytes)) };
  } else {
    throw new ExtractionError("Tipo de archivo no admitido. Usa PDF, Word (.docx) o texto (.txt)");
  }
  if (!result.text) throw new ExtractionError("No se encontró texto en el contenido");
  return result;
}
