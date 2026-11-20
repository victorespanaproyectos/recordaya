import "server-only";
import { ConfigError } from "@/lib/env";

/**
 * Configuración global del chatbot, leída de variables de entorno (06 §13.4).
 * Nada se asume: lo que la spec deja pendiente (ids de modelos del proveedor gratuito) viene del entorno.
 */

/** Valor de `chatbot_settings.llm_model` que significa "usa el modelo por defecto del entorno". */
export const DEFAULT_MODEL_KEY = "default";

/** Kill switch global: solo `true` lo activa. Apagado = todos los negocios usan la ruta legacy. */
export function isChatbotGloballyEnabled(): boolean {
  return process.env.CHATBOT_ENABLED === "true";
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Piloto: si CHATBOT_ALLOWLIST_PHONES tiene valores, solo esos teléfonos pasan por el chatbot.
 * Vacía = sin restricción.
 */
export function isPhoneAllowedForChatbot(phone: string): boolean {
  const allow = csv("CHATBOT_ALLOWLIST_PHONES").map((p) => p.replace(/\D/g, ""));
  if (allow.length === 0) return true;
  return allow.includes(phone.replace(/\D/g, ""));
}

/** Lista blanca de modelos que un negocio puede elegir (`CHATBOT_ALLOWED_MODELS`) más "default". */
export function getAllowedModels(): string[] {
  return [DEFAULT_MODEL_KEY, ...csv("CHATBOT_ALLOWED_MODELS").filter((m) => m !== DEFAULT_MODEL_KEY)];
}

export function isAllowedModel(model: string): boolean {
  return getAllowedModels().includes(model);
}

/** Modelo efectivo: el elegido por el negocio, o el del entorno si es "default". Falla si no está permitido. */
export function resolveModel(setting: string): string {
  if (!isAllowedModel(setting)) throw new ConfigError(`Modelo no permitido: ${setting}`);
  if (setting !== DEFAULT_MODEL_KEY) return setting;
  const fallback = process.env.CHATBOT_DEFAULT_MODEL;
  if (!fallback) throw new ConfigError("Falta la variable de entorno CHATBOT_DEFAULT_MODEL.");
  return fallback;
}

function positiveNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ChatbotLimits {
  defaultMonthlyBudgetUsd: number;
  globalDailyBudgetUsd: number;
  knowledgeMaxFileMb: number;
}

/** Límites de gasto y de archivos (valores por defecto de 06 §13.4). */
export function getChatbotLimits(): ChatbotLimits {
  return {
    defaultMonthlyBudgetUsd: positiveNumber("CHATBOT_DEFAULT_MONTHLY_BUDGET_USD", 20),
    globalDailyBudgetUsd: positiveNumber("CHATBOT_GLOBAL_DAILY_BUDGET_USD", 50),
    knowledgeMaxFileMb: positiveNumber("KNOWLEDGE_MAX_FILE_MB", 10),
  };
}
