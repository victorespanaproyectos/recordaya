import { extractText, getDocumentProxy } from "unpdf";
import { normalizePages } from "../normalize";
import { ExtractionError, MAX_FILE_BYTES, MAX_PAGES, MIN_CHARS_PER_PAGE } from "./errors";

/** PDF con texto. Sin OCR: un PDF escaneado se rechaza con un mensaje claro. */
export async function extractPdf(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ExtractionError("El archivo supera el máximo de 10 MB");
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new ExtractionError("El archivo no es un PDF válido");
  }

  let pages: string[];
  try {
    // unpdf transfiere el buffer al worker: se le pasa una copia.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PAGES) throw new ExtractionError(`El PDF tiene ${pdf.numPages} páginas; el máximo es ${MAX_PAGES}`);
    ({ text: pages } = await extractText(pdf, { mergePages: false }));
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    const name = (error as { name?: string })?.name ?? "";
    if (name === "PasswordException") throw new ExtractionError("El PDF está protegido con contraseña");
    throw new ExtractionError("No se pudo leer el PDF: puede estar dañado");
  }

  const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0);
  if (pages.length === 0 || totalChars < MIN_CHARS_PER_PAGE * pages.length) {
    throw new ExtractionError("PDF escaneado sin texto (OCR no soportado)");
  }
  return { text: normalizePages(pages), pages: pages.length };
}
