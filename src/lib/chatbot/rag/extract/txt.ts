import { ExtractionError, MAX_FILE_BYTES } from "./errors";

/** TXT: UTF-8 estricto con respaldo en latin1 (windows-1252). Rechaza binarios (bytes nulos). */
export function extractTxt(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) throw new ExtractionError("El archivo está vacío");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ExtractionError("El archivo supera el máximo de 10 MB");
  if (bytes.includes(0)) throw new ExtractionError("El archivo parece binario, no es un texto");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
