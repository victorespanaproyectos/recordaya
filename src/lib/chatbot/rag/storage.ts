import "server-only";
import { randomUUID } from "node:crypto";
import { ServiceError } from "@/lib/appointments/service";
import { getChatbotLimits } from "@/lib/chatbot/config";
import { ALLOWED_FILE_MIMES } from "@/lib/chatbot/rag/extract";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/** Archivos de la base de conocimiento en el bucket privado `knowledge` (migración 0011). Rutas: `{business_id}/{uuid}/{nombre}`. */

export const BUCKET = "knowledge";
const HARD_LIMIT_BYTES = 10 * 1024 * 1024;

const storage = () => getSupabaseAdmin().storage.from(BUCKET);

export function maxFileBytes(): number {
  return Math.min(getChatbotLimits().knowledgeMaxFileMb * 1024 * 1024, HARD_LIMIT_BYTES);
}

function assertAllowed(mimeType: string, sizeBytes: number) {
  if (!(ALLOWED_FILE_MIMES as readonly string[]).includes(mimeType)) {
    throw new ServiceError("Tipo de archivo no admitido. Usa PDF, Word (.docx) o texto (.txt)");
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new ServiceError("El archivo está vacío");
  if (sizeBytes > maxFileBytes()) {
    throw new ServiceError(`El archivo supera el máximo de ${Math.floor(maxFileBytes() / 1024 / 1024)} MB`);
  }
}

/** Nombre seguro para la ruta: sin carpetas ni caracteres raros. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(-100);
  return cleaned || "archivo";
}

/** La ruta siempre pertenece al negocio: prefijo exacto y sin segmentos `..`. */
export function isBusinessPath(businessId: string, path: string): boolean {
  return path.startsWith(`${businessId}/`) && !path.split("/").some((s) => s === ".." || s === "." || s === "");
}

export interface UploadTarget {
  path: string;
  token: string;
}

/** Paso 1 de la subida: valida tipo y tamaño declarados y entrega una URL firmada de un solo uso. */
export async function createUploadTarget(
  businessId: string,
  file: { name: string; mimeType: string; sizeBytes: number },
): Promise<UploadTarget> {
  assertAllowed(file.mimeType, file.sizeBytes);
  const path = `${businessId}/${randomUUID()}/${safeFileName(file.name)}`;
  const { data, error } = await storage().createSignedUploadUrl(path);
  if (error || !data) throw new Error(`No se pudo preparar la subida: ${error?.message}`);
  return { path, token: data.token };
}

/**
 * Paso 2: comprueba lo que realmente quedó guardado (tamaño y tipo reales, no los declarados).
 * Si no cumple, borra el objeto. Devuelve los datos reales.
 */
export async function verifyUploadedObject(
  businessId: string,
  path: string,
): Promise<{ mimeType: string; sizeBytes: number }> {
  if (!isBusinessPath(businessId, path)) throw new ServiceError("El archivo no pertenece a este negocio");

  const slash = path.lastIndexOf("/");
  const { data, error } = await storage().list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 100 });
  if (error) throw error;
  const object = data?.find((o) => o.name === path.slice(slash + 1));
  const meta = object?.metadata as { size?: number; mimetype?: string } | null | undefined;
  if (!object || !meta?.size) throw new ServiceError("No se encontró el archivo subido. Intenta de nuevo");

  try {
    assertAllowed(meta.mimetype ?? "", meta.size);
  } catch (e) {
    await deleteObject(businessId, path);
    throw e;
  }
  return { mimeType: meta.mimetype!, sizeBytes: meta.size };
}

export async function downloadObject(businessId: string, path: string): Promise<Uint8Array> {
  if (!isBusinessPath(businessId, path)) throw new ServiceError("El archivo no pertenece a este negocio");
  const { data, error } = await storage().download(path);
  if (error || !data) throw new Error(`No se pudo leer el archivo: ${error?.message}`);
  return new Uint8Array(await data.arrayBuffer());
}

export async function deleteObject(businessId: string, path: string): Promise<void> {
  if (!isBusinessPath(businessId, path)) return;
  const { error } = await storage().remove([path]);
  if (error) console.warn("[knowledge] no se pudo borrar el archivo", error.message);
}
