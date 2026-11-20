/** Subida de archivos con Storage real (proyecto de desarrollo): URL firmada, verificación del objeto y aislamiento. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasMinRole } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { createUploadTarget, deleteObject, downloadObject, isBusinessPath, safeFileName, verifyUploadedObject, BUCKET } from "@/lib/chatbot/rag/storage";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
const state: { member: Member | null } = { member: null };
vi.mock("@/lib/auth/session", () => ({
  requireMember: async (min: Member["role"]) => {
    if (!state.member) throw new Error("NEXT_REDIRECT");
    if (!hasMinRole(state.member.role, min)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return state.member;
  },
}));
import { confirmUploadAction, requestUploadAction } from "@/app/panel/conocimiento/actions";

describe("rutas y nombres", () => {
  it("safeFileName quita carpetas, tildes y caracteres raros", () => {
    expect(safeFileName("../../etc/pasa wd.pdf")).toBe("pasa_wd.pdf");
    expect(safeFileName("C:\\docs\\Lista de precios ñ.docx")).toBe("Lista_de_precios_n.docx");
    expect(safeFileName("...")).toBe("archivo");
    expect(safeFileName("")).toBe("archivo");
    expect(safeFileName("a".repeat(300) + ".pdf").length).toBeLessThanOrEqual(100);
  });
  it("isBusinessPath exige el prefijo exacto y rechaza segmentos peligrosos", () => {
    expect(isBusinessPath("b1", "b1/x/a.pdf")).toBe(true);
    expect(isBusinessPath("b1", "b2/x/a.pdf")).toBe(false);
    expect(isBusinessPath("b1", "b1x/a.pdf")).toBe(false);
    expect(isBusinessPath("b1", "b1/../b2/a.pdf")).toBe(false);
    expect(isBusinessPath("b1", "b1//a.pdf")).toBe(false);
    expect(isBusinessPath("b1", "b1/")).toBe(false);
  });
});

describe.skipIf(!hasDb)("subida de archivos", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  let adminA: Member;
  const uploaded: string[] = [];
  const PDF = { name: "Lista de precios.pdf", mimeType: "application/pdf" };

  async function upload(path: string, token: string, content: string | Uint8Array, contentType: string) {
    const { error } = await db().storage.from(BUCKET).uploadToSignedUrl(path, token, content as never, { contentType });
    if (error) throw error;
    uploaded.push(path);
  }

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    const { data } = await db()
      .from("business_members")
      .insert({ business_id: a.id, email: `admin-${RUN_ID}@example.test`, display_name: "admin", role: "admin", status: "active" })
      .select("id")
      .single();
    adminA = { id: data!.id, userId: null, businessId: a.id, role: "admin", displayName: "admin", legacy: false };
    state.member = adminA;
  }, 60_000);
  afterAll(async () => {
    if (uploaded.length) await db().storage.from(BUCKET).remove(uploaded);
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);

  it("rechaza tipos no admitidos, archivos vacíos y de 11 MB antes de firmar nada", async () => {
    await expect(createUploadTarget(a.id, { name: "x.png", mimeType: "image/png", sizeBytes: 10 })).rejects.toMatchObject({ message: expect.stringContaining("no admitido") });
    await expect(createUploadTarget(a.id, { ...PDF, sizeBytes: 0 })).rejects.toMatchObject({ message: expect.stringContaining("vacío") });
    await expect(createUploadTarget(a.id, { ...PDF, sizeBytes: 11 * 1024 * 1024 })).rejects.toMatchObject({ message: expect.stringContaining("10 MB") });
  });

  it("la ruta firmada siempre lleva el prefijo del negocio y un nombre seguro", async () => {
    const t = await createUploadTarget(a.id, { name: "../../otro/Lista de precios.pdf", mimeType: "application/pdf", sizeBytes: 100 });
    expect(t.path).toMatch(new RegExp(`^${a.id}/[0-9a-f-]{36}/otro_Lista_de_precios.pdf$|^${a.id}/[0-9a-f-]{36}/Lista_de_precios.pdf$`));
    expect(t.token).toBeTruthy();
  });

  it("flujo completo: pedir, subir, confirmar → fuente de archivo con tamaño y tipo reales", async () => {
    const content = "Lista de precios\nCorte: 400 pesos";
    const req = await requestUploadAction({ ...PDF, name: "Precios.txt", mimeType: "text/plain", sizeBytes: content.length });
    if (!req.ok) throw new Error(req.error);
    await upload(req.path, req.token, content, "text/plain");

    const res = await confirmUploadAction({ path: req.path, title: "Precios", category: "products_services" });
    expect(res).toMatchObject({ ok: true, id: expect.any(String) });
    const { data: src } = await db().from("knowledge_sources").select("type, category, storage_path, status").eq("id", res.id!).single();
    expect(src).toEqual({ type: "file", category: "products_services", storage_path: req.path, status: "pending" });
    const { data: doc } = await db().from("knowledge_documents").select("mime_type, size_bytes, status").eq("source_id", res.id!).single();
    expect(doc).toEqual({ mime_type: "text/plain", size_bytes: content.length, status: "pending" });
    expect(new TextDecoder().decode(await downloadObject(a.id, req.path))).toBe(content);
  });

  it("confirmar algo que no se subió falla con un mensaje claro", async () => {
    const req = await requestUploadAction({ ...PDF, sizeBytes: 100 });
    if (!req.ok) throw new Error(req.error);
    expect(await confirmUploadAction({ path: req.path, title: "Fantasma" })).toMatchObject({ ok: false, error: expect.stringContaining("No se encontró") });
  });

  it("confirmar una ruta de otro negocio o con '..' se rechaza", async () => {
    expect(await confirmUploadAction({ path: `${b.id}/x/a.pdf`, title: "Ajeno" })).toMatchObject({ ok: false, error: expect.stringContaining("no pertenece") });
    expect(await confirmUploadAction({ path: `${a.id}/../${b.id}/a.pdf`, title: "Ajeno" })).toMatchObject({ ok: false, error: expect.stringContaining("no pertenece") });
    await expect(downloadObject(a.id, `${b.id}/x/a.pdf`)).rejects.toMatchObject({ message: expect.stringContaining("no pertenece") });
  });

  it("si la fuente no se puede crear (título vacío), el archivo subido se borra", async () => {
    const req = await requestUploadAction({ name: "x.txt", mimeType: "text/plain", sizeBytes: 5 });
    if (!req.ok) throw new Error(req.error);
    await upload(req.path, req.token, "hola!", "text/plain");
    expect(await confirmUploadAction({ path: req.path, title: "  " })).toMatchObject({ ok: false });
    await expect(verifyUploadedObject(a.id, req.path)).rejects.toMatchObject({ message: expect.stringContaining("No se encontró") });
  });

  it("deleteObject ignora rutas de otro negocio", async () => {
    const t = await createUploadTarget(a.id, { name: "k.txt", mimeType: "text/plain", sizeBytes: 3 });
    await upload(t.path, t.token, "abc", "text/plain");
    await deleteObject(b.id, t.path); // otro negocio: no borra
    await expect(verifyUploadedObject(a.id, t.path)).resolves.toMatchObject({ sizeBytes: 3 });
  });

  it("un operador no puede pedir subidas (403)", async () => {
    state.member = { ...adminA, role: "operator" };
    await expect(requestUploadAction({ ...PDF, sizeBytes: 10 })).rejects.toThrow("403");
    state.member = adminA;
  });
});
