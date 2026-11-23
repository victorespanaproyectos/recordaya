import "server-only";
import { getChatbotLimits } from "@/lib/chatbot/config";
import { dayKey, zonedToUtc } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type BudgetResult = { ok: true } | { ok: false; reason: "budget_exhausted"; scope: "business_monthly" | "global_daily" };

async function sumCost(businessId: string | null, since: Date): Promise<number> {
  let query = getSupabaseAdmin().from("chatbot_usage").select("cost_usd").gte("created_at", since.toISOString());
  if (businessId) query = query.eq("business_id", businessId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd), 0);
}

/** Inicio del mes en curso (00:00 del día 1) en la zona del negocio. */
export function startOfMonth(now: Date, timeZone: string): Date {
  return zonedToUtc(`${dayKey(now, timeZone).slice(0, 8)}01`, "00:00", timeZone)!;
}

/**
 * ¿Puede el negocio seguir usando IA? Falla si el gasto del mes (zona del negocio) alcanzó su tope mensual
 * o si el gasto global del día (UTC) alcanzó `CHATBOT_GLOBAL_DAILY_BUDGET_USD`. Un tope de 0 bloquea todo.
 */
export async function assertBudget(businessId: string, now: Date = new Date()): Promise<BudgetResult> {
  const db = getSupabaseAdmin();
  const [{ data: biz, error: bizError }, { data: settings, error: settingsError }] = await Promise.all([
    db.from("businesses").select("timezone").eq("id", businessId).single(),
    db.from("chatbot_settings").select("monthly_budget_usd").eq("business_id", businessId).maybeSingle(),
  ]);
  if (bizError) throw bizError;
  if (settingsError) throw settingsError;

  const limits = getChatbotLimits();
  const monthly = settings ? Number(settings.monthly_budget_usd) : limits.defaultMonthlyBudgetUsd;
  const spentMonth = await sumCost(businessId, startOfMonth(now, biz.timezone));
  if (spentMonth >= monthly) return { ok: false, reason: "budget_exhausted", scope: "business_monthly" };

  const startOfUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((await sumCost(null, startOfUtcDay)) >= limits.globalDailyBudgetUsd) {
    return { ok: false, reason: "budget_exhausted", scope: "global_daily" };
  }
  return { ok: true };
}
