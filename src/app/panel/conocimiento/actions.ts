"use server";

import { refresh } from "next/cache";
import { ServiceError } from "@/lib/appointments/service";
import { requireMember } from "@/lib/auth/session";
import { CATEGORIES, createSource, newVersion, setEnabled, softDelete, updateSource, type SourcePatch } from "@/lib/chatbot/rag/sources";
import { ignoreQuestions, resolveWithFaq } from "@/lib/chatbot/unanswered";
import { createUploadTarget, deleteObject, verifyUploadedObject } from "@/lib/chatbot/rag/storage";
import type { ActionResult } from "../actions";

function toError(error: unknown, scope: string): { ok: false; error: string } {
  if (error instanceof ServiceError) return { ok: false, error: error.message };
  console.error(`[panel/conocimiento/${scope}]`, error);
  return { ok: false, error: "Algo salió mal. Intenta de nuevo en unos segundos." };
}

const text = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : "";
};
const category = (f: FormData) => {
  const c = text(f, "category");
  return (CATEGORIES as readonly string[]).includes(c) ? (c as (typeof CATEGORIES)[number]) : undefined;
};

/** Crea una fuente de tipo FAQ, texto o página web desde el formulario. */
export async function createSourceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const member = await requireMember("admin");
  const type = text(formData, "type");
  const base = { title: text(formData, "title"), category: category(formData) };
  try {
    const input =
      type === "faq"
        ? { type: "faq" as const, ...base, question: text(formData, "question"), answer: text(formData, "answer") }
        : type === "text"
          ? { type: "text" as const, ...base, body: text(formData, "body") }
          : type === "url"
            ? { type: "url" as const, ...base, url: text(formData, "url") }
            : null;
    if (!input) return { ok: false, error: "Tipo de fuente inválido" };
    const source = await createSource(member.businessId, input, member);
    refresh();
    return { ok: true, message: "Fuente agregada; se está procesando", id: source.id };
  } catch (error) {
    return toError(error, "createSource");
  }
}

/** Edita una fuente: título y categoría se guardan al instante; si cambia el contenido, se reprocesa. */
export async function updateSourceAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const member = await requireMember("admin");
  const patch: SourcePatch = { title: text(formData, "title"), category: category(formData) };
  for (const key of ["question", "answer", "body", "url"] as const) if (formData.has(key)) patch[key] = text(formData, key);
  try {
    await updateSource(member.businessId, text(formData, "id"), patch, member);
    refresh();
    return { ok: true, message: "Cambios guardados" };
  } catch (error) {
    return toError(error, "updateSource");
  }
}

export async function setSourceEnabledAction(id: string, enabled: boolean): Promise<ActionResult> {
  const member = await requireMember("admin");
  try {
    await setEnabled(member.businessId, id, enabled, member);
    refresh();
    return { ok: true, message: enabled ? "Fuente activada" : "Fuente desactivada" };
  } catch (error) {
    return toError(error, "setEnabled");
  }
}

export async function deleteSourceAction(id: string): Promise<ActionResult> {
  const member = await requireMember("admin");
  try {
    await softDelete(member.businessId, id, member);
    refresh();
    return { ok: true, message: "Fuente eliminada" };
  } catch (error) {
    return toError(error, "deleteSource");
  }
}

/** Reintenta el procesamiento creando una versión nueva con el mismo contenido. */
export async function retrySourceAction(id: string): Promise<ActionResult> {
  const member = await requireMember("admin");
  try {
    await newVersion(id, member.businessId, member);
    refresh();
    return { ok: true, message: "Reintentando el procesamiento" };
  } catch (error) {
    return toError(error, "retry");
  }
}

export type UploadRequestResult = { ok: true; path: string; token: string } | { ok: false; error: string };

/** Paso 1: valida el archivo declarado y entrega una URL firmada para subirlo directo a Storage. */
export async function requestUploadAction(file: { name: string; mimeType: string; sizeBytes: number }): Promise<UploadRequestResult> {
  const member = await requireMember("admin");
  try {
    const target = await createUploadTarget(member.businessId, file);
    return { ok: true, ...target };
  } catch (error) {
    return toError(error, "requestUpload");
  }
}

/** Paso 2: comprueba el archivo realmente subido y crea la fuente (si no es válido, lo borra). */
export async function confirmUploadAction(input: { path: string; title: string; category?: string }): Promise<ActionResult> {
  const member = await requireMember("admin");
  try {
    const { mimeType, sizeBytes } = await verifyUploadedObject(member.businessId, input.path);
    const category = (CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as (typeof CATEGORIES)[number]) : "other";
    try {
      const source = await createSource(
        member.businessId,
        { type: "file", title: input.title, category, storagePath: input.path, mimeType, sizeBytes },
        member,
      );
      refresh();
      return { ok: true, message: "Archivo recibido; se está procesando", id: source.id };
    } catch (error) {
      await deleteObject(member.businessId, input.path); // no dejar archivos huérfanos si la fuente no se crea
      throw error;
    }
  } catch (error) {
    return toError(error, "confirmUpload");
  }
}

/** «Crear FAQ con esta pregunta»: crea la FAQ y resuelve las preguntas del grupo con `resolved_source_id`. */
export async function resolveUnansweredWithFaqAction(input: { ids: string[]; title: string; question: string; answer: string; category?: string }): Promise<ActionResult> {
  const member = await requireMember("admin");
  try {
    const category = (CATEGORIES as readonly string[]).includes(input.category ?? "") ? (input.category as (typeof CATEGORIES)[number]) : "faq";
    const r = await resolveWithFaq(member, input.ids, { title: String(input.title ?? ""), question: String(input.question ?? ""), answer: String(input.answer ?? ""), category });
    refresh();
    return { ok: true, id: r.sourceId, message: `FAQ creada; ${r.resolved} ${r.resolved === 1 ? "pregunta resuelta" : "preguntas resueltas"}` };
  } catch (error) {
    return toError(error, "resolveUnanswered");
  }
}

export async function ignoreUnansweredAction(ids: string[]): Promise<ActionResult> {
  const member = await requireMember("admin");
  try {
    const n = await ignoreQuestions(member, ids);
    refresh();
    return { ok: true, message: n === 1 ? "Pregunta ignorada" : `${n} preguntas ignoradas` };
  } catch (error) {
    return toError(error, "ignoreUnanswered");
  }
}
