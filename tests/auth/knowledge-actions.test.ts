/** Acciones del panel de conocimiento: permisos, validación y aislamiento entre negocios (T-05.7). */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMinRole } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
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
import {
  createSourceAction,
  deleteSourceAction,
  retrySourceAction,
  setSourceEnabledAction,
  updateSourceAction,
} from "@/app/panel/conocimiento/actions";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe.skipIf(!hasDb)("acciones de conocimiento", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  const members: Record<string, Member> = {};

  async function member(biz: TestBusiness, role: Member["role"]): Promise<Member> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `${role}-${biz.id.slice(0, 4)}-${RUN_ID}@example.test`, display_name: role, role, status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role, displayName: role, legacy: false };
  }
  const create = async (fields: Record<string, string>) => {
    const r = await createSourceAction(null, form(fields));
    if (!r.ok) throw new Error(r.error);
    return r.id!;
  };
  const row = async (id: string) => (await db().from("knowledge_sources").select("title, category, status, deleted_at, faq_answer").eq("id", id).single()).data!;

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    members.adminA = await member(a, "admin");
    members.operatorA = await member(a, "operator");
    members.adminB = await member(b, "admin");
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);
  beforeEach(() => {
    state.member = members.adminA;
  });

  it("operador y sin sesión no pueden ejecutar ninguna acción", async () => {
    const id = await create({ type: "faq", title: "F", question: "¿q?", answer: "a" });
    state.member = members.operatorA;
    await expect(createSourceAction(null, form({ type: "faq", title: "X", question: "q", answer: "a" }))).rejects.toThrow("403");
    await expect(updateSourceAction(null, form({ id, title: "X" }))).rejects.toThrow("403");
    await expect(setSourceEnabledAction(id, false)).rejects.toThrow("403");
    await expect(deleteSourceAction(id)).rejects.toThrow("403");
    await expect(retrySourceAction(id)).rejects.toThrow("403");
    state.member = null;
    await expect(deleteSourceAction(id)).rejects.toThrow("NEXT_REDIRECT");
    expect((await row(id)).deleted_at).toBeNull();
  });

  it("crea FAQ, texto y página web; categoría inválida cae en 'other'", async () => {
    const f = await create({ type: "faq", title: "Horario", category: "hours", question: "¿Cuándo abren?", answer: "9 a 18" });
    const t = await create({ type: "text", title: "Política", category: "inventada", body: "No hay devoluciones" });
    const u = await create({ type: "url", title: "Web", url: "https://example.com" });
    expect(await row(f)).toMatchObject({ category: "hours", status: "pending" });
    expect(await row(t)).toMatchObject({ category: "other" });
    expect((await row(u)).title).toBe("Web");
  });

  it("errores de validación llegan como mensajes legibles", async () => {
    expect(await createSourceAction(null, form({ type: "faq", title: "", question: "q", answer: "a" }))).toMatchObject({ ok: false, error: expect.stringContaining("título") });
    expect(await createSourceAction(null, form({ type: "url", title: "x", url: "http://inseguro.com" }))).toMatchObject({ ok: false, error: expect.stringContaining("https://") });
    expect(await createSourceAction(null, form({ type: "video", title: "x" }))).toMatchObject({ ok: false, error: "Tipo de fuente inválido" });
  });

  it("editar: título/categoría al instante; el contenido crea una versión", async () => {
    const id = await create({ type: "faq", title: "Precios", question: "¿Cuánto?", answer: "400" });
    expect(await updateSourceAction(null, form({ id, title: "Lista de precios", category: "products_services", question: "¿Cuánto?", answer: "400" }))).toMatchObject({ ok: true });
    expect(await row(id)).toMatchObject({ title: "Lista de precios", category: "products_services", faq_answer: "400" });
    expect((await db().from("knowledge_documents").select("id").eq("source_id", id)).data).toHaveLength(1);

    await updateSourceAction(null, form({ id, title: "Lista de precios", question: "¿Cuánto?", answer: "450" }));
    expect((await row(id)).faq_answer).toBe("450");
    expect((await db().from("knowledge_documents").select("id").eq("source_id", id)).data).toHaveLength(2);
  });

  it("desactivar, reintentar y eliminar", async () => {
    const id = await create({ type: "text", title: "Ciclo", body: "texto de la fuente" });
    expect(await setSourceEnabledAction(id, false)).toMatchObject({ ok: true, message: "Fuente desactivada" });
    expect((await row(id)).status).toBe("disabled");
    expect(await setSourceEnabledAction(id, true)).toMatchObject({ ok: true, message: "Fuente activada" });
    expect(await retrySourceAction(id)).toMatchObject({ ok: true });
    expect((await db().from("knowledge_documents").select("id").eq("source_id", id)).data).toHaveLength(2);
    expect(await deleteSourceAction(id)).toMatchObject({ ok: true });
    expect((await row(id)).deleted_at).not.toBeNull();
    expect(await deleteSourceAction(id)).toMatchObject({ ok: false, error: "La fuente no existe" });
  });

  it("aislamiento: un admin de otro negocio no puede ver ni tocar la fuente (siempre 'no existe')", async () => {
    const id = await create({ type: "faq", title: "Privada", question: "¿s?", answer: "secreto de A" });
    state.member = members.adminB;
    for (const result of [
      await updateSourceAction(null, form({ id, title: "hack" })),
      await setSourceEnabledAction(id, false),
      await retrySourceAction(id),
      await deleteSourceAction(id),
    ]) {
      expect(result).toEqual({ ok: false, error: "La fuente no existe" });
    }
    expect(await row(id)).toMatchObject({ title: "Privada", status: "pending", deleted_at: null });
  });
});
