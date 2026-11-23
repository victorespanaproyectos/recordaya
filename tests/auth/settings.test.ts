/** Servicio de configuración del chatbot contra la base real: permisos, validación, persistencia y auditoría. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, getChatbotSettings, upsertChatbotSettings } from "@/lib/chatbot/settings";
import type { Member } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();

describe.skipIf(!hasDb)("configuración del chatbot", () => {
  let biz: TestBusiness;
  let owner: Member;
  let admin: Member;
  let operator: Member;

  async function member(role: Member["role"]): Promise<Member> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `${role}-${RUN_ID}@example.test`, display_name: role, role, status: "active" })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role, displayName: role, legacy: false };
  }
  const audits = async () =>
    (await db().from("audit_log").select("action, actor_member_id, diff").eq("business_id", biz.id).eq("action", "settings.updated").order("id")).data!;

  beforeAll(async () => {
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "m-a");
    biz = await createTestBusiness();
    owner = await member("owner");
    admin = await member("admin");
    operator = await member("operator");
  }, 60_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup(biz?.id);
  }, 60_000);

  it("sin fila devuelve los valores por defecto (desactivado)", async () => {
    expect(await getChatbotSettings(biz.id)).toEqual(DEFAULT_SETTINGS);
  });

  it("los valores por defecto del código coinciden con los de la base", async () => {
    // Se crea la fila solo con el negocio: lo que devuelve la base debe ser igual al DEFAULT_SETTINGS.
    await db().from("chatbot_settings").insert({ business_id: biz.id });
    expect(await getChatbotSettings(biz.id)).toEqual(DEFAULT_SETTINGS);
    await db().from("chatbot_settings").delete().eq("business_id", biz.id);
  });

  it("un operador no puede cambiar nada (403)", async () => {
    await expect(upsertChatbotSettings(biz.id, { assistant_name: "X" }, operator)).rejects.toMatchObject({ status: 403 });
    expect(await audits()).toEqual([]);
  });

  it("un admin crea la fila al primer guardado, la persiste y audita", async () => {
    const hours = { mon: [["09:00", "13:00"]], exceptions: [{ date: "2026-12-25", closed: true }] } as never;
    const saved = await upsertChatbotSettings(
      biz.id,
      { enabled: true, assistant_name: " Sofi ", tone: "formal", confidence_threshold: 0.75, human_hours: hours, closing_message: "Chau" },
      admin,
    );
    expect(saved).toMatchObject({ enabled: true, assistant_name: "Sofi", tone: "formal", confidence_threshold: 0.75, closing_message: "Chau" });

    const reloaded = await getChatbotSettings(biz.id);
    expect(reloaded).toEqual({ ...DEFAULT_SETTINGS, ...saved });
    expect(reloaded.human_hours).toEqual(hours);
    expect(typeof reloaded.confidence_threshold).toBe("number");

    const { data: row } = await db().from("chatbot_settings").select("updated_by").eq("business_id", biz.id).single();
    expect(row!.updated_by).toBe(admin.id);
    const logs = await audits();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_member_id: admin.id });
    expect(logs[0].diff).toMatchObject({ created: true, assistant_name: { from: "Asistente", to: "Sofi" } });
  });

  it("guardar lo mismo no audita; un cambio real audita solo el campo cambiado", async () => {
    const before = (await audits()).length;
    await upsertChatbotSettings(biz.id, { assistant_name: "Sofi", tone: "formal" }, admin);
    expect(await audits()).toHaveLength(before);

    await upsertChatbotSettings(biz.id, { max_answer_chars: 900 }, admin);
    const logs = await audits();
    expect(logs).toHaveLength(before + 1);
    expect(logs.at(-1)!.diff).toEqual({ max_answer_chars: { from: 700, to: 900 } });
    expect((await getChatbotSettings(biz.id)).assistant_name).toBe("Sofi"); // lo demás intacto
  });

  it("modelo, esfuerzo y tope: solo owner", async () => {
    for (const patch of [{ llm_model: "m-a" }, { llm_effort: "high" as const }, { monthly_budget_usd: 5 }]) {
      await expect(upsertChatbotSettings(biz.id, patch, admin)).rejects.toMatchObject({ status: 403 });
    }
    // Mezclar un campo permitido con uno de owner no guarda nada.
    await expect(upsertChatbotSettings(biz.id, { assistant_name: "Otro", monthly_budget_usd: 5 }, admin)).rejects.toMatchObject({ status: 403 });
    expect((await getChatbotSettings(biz.id)).assistant_name).toBe("Sofi");

    const saved = await upsertChatbotSettings(biz.id, { llm_model: "m-a", llm_effort: "medium", monthly_budget_usd: 7.5 }, owner);
    expect(saved).toMatchObject({ llm_model: "m-a", llm_effort: "medium", monthly_budget_usd: 7.5 });
    expect(await getChatbotSettings(biz.id)).toMatchObject({ llm_model: "m-a", monthly_budget_usd: 7.5 });
  });

  it("configuración inválida → ServiceError 400 con mensaje legible, sin guardar", async () => {
    const before = await getChatbotSettings(biz.id);
    await expect(upsertChatbotSettings(biz.id, { max_answer_chars: 50 }, owner)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("entre 200 y 1500"),
    });
    await expect(upsertChatbotSettings(biz.id, { llm_model: "nope" }, owner)).rejects.toMatchObject({ status: 400, message: "El modelo elegido no está permitido" });
    await expect(
      upsertChatbotSettings(biz.id, { human_hours: { mon: [["09:00", "13:00"], ["12:00", "15:00"]] } as never }, admin),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("se solapan") });
    await expect(upsertChatbotSettings(biz.id, { business_id: "x" } as never, admin)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("desconocido") });
    expect(await getChatbotSettings(biz.id)).toEqual(before);
  });

  it("la configuración es por negocio", async () => {
    const other = await createTestBusiness();
    try {
      expect(await getChatbotSettings(other.id)).toEqual(DEFAULT_SETTINGS);
    } finally {
      await cleanup(other.id);
    }
  });
});
