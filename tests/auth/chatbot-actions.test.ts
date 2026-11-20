/**
 * updateChatbotSettingsAction: traducción del formulario, permisos y mensajes de error.
 * `requireMember` se sustituye por un miembro de prueba con el rol indicado (su lógica real ya se prueba en member-session).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMinRole } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { getChatbotSettings } from "@/lib/chatbot/settings";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const state: { member: Member | null } = { member: null };

vi.mock("@/lib/auth/session", () => ({
  requireMember: async (min: Member["role"]) => {
    if (!state.member) throw new Error("NEXT_REDIRECT");
    if (!hasMinRole(state.member.role, min)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return state.member;
  },
}));

import { updateChatbotSettingsAction } from "@/app/panel/chatbot/actions";

function form(extra: Record<string, string> = {}, omit: string[] = []): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    enabled: "on",
    assistant_name: "Sofi",
    business_description: "",
    tone: "formal",
    personality: "",
    instructions: "",
    language: "es",
    auto_language: "on",
    welcome_message: "Hola desde {negocio}",
    handoff_offer_message: "¿Te paso con alguien?",
    handoff_confirmed_message: "Listo",
    out_of_hours_message: "Volvemos {proximo_horario}",
    no_info_message: "No sé",
    closing_message: "",
    unsupported_content_message: "Solo texto",
    human_hours: JSON.stringify({ mon: [["09:00", "18:00"]] }),
    max_answer_chars: "700",
    offer_human_after_failures: "2",
    inactivity_close_hours: "24",
    answer_questions_on_reminder_replies: "on",
    confidence_threshold: "0.6",
    ...extra,
  };
  for (const [k, v] of Object.entries(base)) if (!omit.includes(k)) f.set(k, v);
  return f;
}

describe.skipIf(!hasDb)("updateChatbotSettingsAction", () => {
  let biz: TestBusiness;
  const members: Record<string, Member> = {};

  beforeAll(async () => {
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "m-a");
    biz = await createTestBusiness();
    for (const role of ["owner", "admin", "operator"] as const) {
      const { data, error } = await getSupabaseAdmin()
        .from("business_members")
        .insert({ business_id: biz.id, email: `${role}-${RUN_ID}@example.test`, display_name: role, role, status: "active" })
        .select("id")
        .single();
      if (error) throw error;
      members[role] = { id: data.id, userId: null, businessId: biz.id, role, displayName: role, legacy: false };
    }
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await cleanup(biz?.id);
  }, 60_000);
  beforeEach(() => {
    state.member = members.admin;
  });

  it("operador y sin sesión no llegan a guardar nada", async () => {
    state.member = members.operator;
    await expect(updateChatbotSettingsAction(null, form())).rejects.toThrow("403");
    state.member = null;
    await expect(updateChatbotSettingsAction(null, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(await getChatbotSettings(biz.id)).toMatchObject({ enabled: false, assistant_name: "Asistente" });
  });

  it("admin guarda; el negocio sale de la sesión, no del formulario", async () => {
    const other = await createTestBusiness();
    try {
      const result = await updateChatbotSettingsAction(null, form({ business_id: other.id, businessId: other.id }));
      expect(result).toEqual({ ok: true, message: "Configuración guardada" });
      expect(await getChatbotSettings(biz.id)).toMatchObject({ enabled: true, assistant_name: "Sofi", tone: "formal", human_hours: { mon: [["09:00", "18:00"]] } });
      expect(await getChatbotSettings(other.id)).toMatchObject({ enabled: false, assistant_name: "Asistente" });
    } finally {
      await cleanup(other.id);
    }
  });

  it("casillas sin marcar se guardan como falso", async () => {
    await updateChatbotSettingsAction(null, form({}, ["enabled", "auto_language"]));
    expect(await getChatbotSettings(biz.id)).toMatchObject({ enabled: false, auto_language: false });
  });

  it("un admin que envía campos de IA recibe un error y no se guarda nada", async () => {
    const result = await updateChatbotSettingsAction(null, form({ assistant_name: "Cambiado", llm_model: "m-a", llm_effort: "low", monthly_budget_usd: "5" }));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("owner") });
    expect((await getChatbotSettings(biz.id)).assistant_name).toBe("Sofi");
  });

  it("el owner guarda también modelo, esfuerzo y tope", async () => {
    state.member = members.owner;
    const result = await updateChatbotSettingsAction(null, form({ llm_model: "m-a", llm_effort: "high", monthly_budget_usd: "12.5" }));
    expect(result.ok).toBe(true);
    expect(await getChatbotSettings(biz.id)).toMatchObject({ llm_model: "m-a", llm_effort: "high", monthly_budget_usd: 12.5 });
  });

  it("un owner sin la pestaña de IA no toca esos campos", async () => {
    state.member = members.owner;
    await updateChatbotSettingsAction(null, form({ assistant_name: "Otra" }));
    expect(await getChatbotSettings(biz.id)).toMatchObject({ assistant_name: "Otra", llm_model: "m-a", monthly_budget_usd: 12.5 });
  });

  it("errores legibles: número vacío, horario inválido y JSON roto", async () => {
    expect(await updateChatbotSettingsAction(null, form({ max_answer_chars: "" }))).toMatchObject({ ok: false, error: expect.stringContaining("número") });
    expect(await updateChatbotSettingsAction(null, form({ human_hours: JSON.stringify({ mon: [["09:00", "13:00"], ["12:00", "15:00"]] }) }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("se solapan"),
    });
    expect(await updateChatbotSettingsAction(null, form({ human_hours: "{roto" }))).toMatchObject({ ok: false, error: expect.stringContaining("horario") });
    expect(await updateChatbotSettingsAction(null, form({ welcome_message: "   " }))).toMatchObject({ ok: false, error: expect.stringContaining("bienvenida") });
  });
});
