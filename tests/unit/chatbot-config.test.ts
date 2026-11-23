import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAllowedModels,
  getChatbotLimits,
  isAllowedModel,
  isChatbotGloballyEnabled,
  isPhoneAllowedForChatbot,
  resolveModel,
} from "@/lib/chatbot/config";

afterEach(() => vi.unstubAllEnvs());

describe("config del chatbot", () => {
  it("kill switch: solo 'true' lo activa", () => {
    for (const v of [undefined, "", "false", "1", "TRUE", "yes"]) {
      vi.stubEnv("CHATBOT_ENABLED", v as string);
      expect(isChatbotGloballyEnabled(), String(v)).toBe(false);
    }
    vi.stubEnv("CHATBOT_ENABLED", "true");
    expect(isChatbotGloballyEnabled()).toBe(true);
  });

  it("lista de teléfonos: vacía permite todos; con valores, solo esos (ignora formato)", () => {
    vi.stubEnv("CHATBOT_ALLOWLIST_PHONES", "");
    expect(isPhoneAllowedForChatbot("59899111222")).toBe(true);
    vi.stubEnv("CHATBOT_ALLOWLIST_PHONES", " +598 99 111 222 , 59899333444");
    expect(isPhoneAllowedForChatbot("59899111222")).toBe(true);
    expect(isPhoneAllowedForChatbot("59899333444")).toBe(true);
    expect(isPhoneAllowedForChatbot("59899000000")).toBe(false);
  });

  it("modelos: 'default' siempre permitido; el resto, solo los del entorno", () => {
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "");
    expect(getAllowedModels()).toEqual(["default"]);
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "m-a, m-b,default");
    expect(getAllowedModels()).toEqual(["default", "m-a", "m-b"]);
    expect(isAllowedModel("m-b")).toBe(true);
    expect(isAllowedModel("otro")).toBe(false);
  });

  it("resolveModel: default → modelo del entorno; no permitido o sin entorno → error", () => {
    vi.stubEnv("CHATBOT_ALLOWED_MODELS", "m-a");
    vi.stubEnv("CHATBOT_DEFAULT_MODEL", "m-def");
    expect(resolveModel("default")).toBe("m-def");
    expect(resolveModel("m-a")).toBe("m-a");
    expect(() => resolveModel("m-x")).toThrow("no permitido");
    vi.stubEnv("CHATBOT_DEFAULT_MODEL", "");
    expect(() => resolveModel("default")).toThrow("CHATBOT_DEFAULT_MODEL");
  });

  it("límites: valores de la spec por defecto; ignora valores inválidos", () => {
    for (const k of ["CHATBOT_DEFAULT_MONTHLY_BUDGET_USD", "CHATBOT_GLOBAL_DAILY_BUDGET_USD", "KNOWLEDGE_MAX_FILE_MB"]) vi.stubEnv(k, "");
    expect(getChatbotLimits()).toEqual({ defaultMonthlyBudgetUsd: 20, globalDailyBudgetUsd: 50, knowledgeMaxFileMb: 10 });
    vi.stubEnv("CHATBOT_DEFAULT_MONTHLY_BUDGET_USD", "5.5");
    vi.stubEnv("KNOWLEDGE_MAX_FILE_MB", "-3");
    expect(getChatbotLimits()).toMatchObject({ defaultMonthlyBudgetUsd: 5.5, knowledgeMaxFileMb: 10 });
  });
});
