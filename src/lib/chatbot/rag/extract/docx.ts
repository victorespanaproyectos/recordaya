import JSZip from "jszip";
import mammoth from "mammoth";
import { ExtractionError, MAX_FILE_BYTES } from "./errors";

const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // anti zip-bomb

/** DOCX: firma ZIP + `word/document.xml`, y tope de descompresión antes de leer nada. */
export async function extractDocx(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ExtractionError("El archivo supera el máximo de 10 MB");
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) {
    throw new ExtractionError("El archivo no es un documento de Word (.docx) válido");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new ExtractionError("El archivo no es un documento de Word (.docx) válido");
  }
  if (!zip.file("word/document.xml")) throw new ExtractionError("El archivo no es un documento de Word (.docx) válido");

  // Tamaño descomprimido declarado en el directorio central del ZIP (sin descomprimir nada).
  let declared = 0;
  zip.forEach((_path, entry) => {
    declared += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  });
  if (declared > MAX_UNCOMPRESSED_BYTES) throw new ExtractionError("El documento es demasiado grande al descomprimirse");

  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    if (!value.trim()) throw new ExtractionError("El documento no tiene texto");
    return value;
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    throw new ExtractionError("No se pudo leer el documento de Word");
  }
}
