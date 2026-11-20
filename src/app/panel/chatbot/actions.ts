"use server";

import { refresh } from "next/cache";
import { ServiceError } from "@/lib/appointments/service";
import { requireMember } from "@/lib/auth/session";
import { upsertChatbotSettings, type ChatbotSettingsPatch } from "@/lib/chatbot/settings";
import type { ActionResult } from "../actions";

const text = (f: FormData, name: string) => {
  const v = f.get(name);
  return typeof v === "string" ? v : "";
};
const bool = (f: FormData, name: string) => f.get(name) === "on";
const num = (f: FormData, name: string) => (text(f, name).trim() === "" ? NaN : Number(text(f, name)));

/**
 * Guarda la configuración del chatbot. Admin: todo menos modelo, esfuerzo y tope mensual (solo owner,
 * validado también en el servicio: ocultar los campos en la pantalla no es la barrera).
 */
export async function updateChatbotSettingsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const member = await requireMember("admin");

  let humanHours: unknown;
  try {
    humanHours = JSON.parse(text(formData, "human_hours") || "{}");
  } catch {
    return { ok: false, error: "El horario no es válido. Recarga la página e intenta de nuevo." };
  }

  const patch: Record<string, unknown> = {
    enabled: bool(formData, "enabled"),
    assistant_name: text(formData, "assistant_name"),
    business_description: text(formData, "business_description"),
    tone: text(formData, "tone"),
    personality: text(formData, "personality"),
    instructions: text(formData, "instructions"),
    language: text(formData, "language"),
    auto_language: bool(formData, "auto_language"),
    welcome_message: text(formData, "welcome_message"),
    handoff_offer_message: text(formData, "handoff_offer_message"),
    handoff_confirmed_message: text(formData, "handoff_confirmed_message"),
    out_of_hours_message: text(formData, "out_of_hours_message"),
    no_info_message: text(formData, "no_info_message"),
    closing_message: text(formData, "closing_message"),
    unsupported_content_message: text(formData, "unsupported_content_message"),
    human_hours: humanHours,
    max_answer_chars: num(formData, "max_answer_chars"),
    offer_human_after_failures: num(formData, "offer_human_after_failures"),
    inactivity_close_hours: num(formData, "inactivity_close_hours"),
    answer_questions_on_reminder_replies: bool(formData, "answer_questions_on_reminder_replies"),
    confidence_threshold: num(formData, "confidence_threshold"),
  };
  // Solo el owner ve la pestaña "IA y consumo"; si el formulario no la trae, no se toca.
  if (formData.has("llm_model")) {
    patch.llm_model = text(formData, "llm_model");
    patch.llm_effort = text(formData, "llm_effort");
    patch.monthly_budget_usd = num(formData, "monthly_budget_usd");
  }

  try {
    await upsertChatbotSettings(member.businessId, patch as ChatbotSettingsPatch, member);
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    console.error("[panel/chatbot]", error);
    return { ok: false, error: "Algo salió mal. Intenta de nuevo en unos segundos." };
  }
  refresh();
  return { ok: true, message: "Configuración guardada" };
}
