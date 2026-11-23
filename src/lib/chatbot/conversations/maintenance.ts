import "server-only";
import { isChatbotGloballyEnabled } from "@/lib/chatbot/config";
import { enqueueChatbotReply } from "@/lib/chatbot/jobs";
import { log } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { CONVERSATION_COLUMNS, toConversation } from "./service";
import { transition } from "./state-machine";

/**
 * Mantenimiento periódico (05 §16.2, T-09.7). Idempotente: una segunda corrida seguida no cambia nada.
 *  - T9  : `bot` sin entrantes 2 h después de la última respuesta → `resolved` (por la IA).
 *  - T11 : `bot`/`resolved` inactivas más de `inactivity_close_hours` → `closed`.
 *  - Disponibilidad: el operador sin actividad del panel en 15 min pasa a no disponible.
 *  - Re-encola mensajes de clientes sin respuesta de la IA hace más de 2 min (un job perdido no deja a nadie sin respuesta).
 */

export const AUTO_RESOLVE_MS = 2 * 60 * 60 * 1000;
export const AVAILABILITY_TTL_MS = 15 * 60 * 1000;
export const REQUEUE_AFTER_MS = 2 * 60 * 1000;
export const BATCH = 100;
export const REQUEUE_BATCH = 20;
const DEFAULT_CLOSE_HOURS = 24;

export interface MaintenanceResult {
  resolved: number;
  closed: number;
  requeued: number;
  unavailable: number;
  purged: number;
}

const db = () => getSupabaseAdmin();
const iso = (ms: number) => new Date(ms).toISOString();

export async function runMaintenance(now: Date = new Date()): Promise<MaintenanceResult> {
  const t = now.getTime();
  const result: MaintenanceResult = { resolved: 0, closed: 0, requeued: 0, unavailable: 0, purged: 0 };
  const system = { type: "system" as const };

  // T9 — la última palabra fue de la IA y el cliente no volvió a escribir.
  const { data: quiet, error: quietError } = await db()
    .from("conversations")
    .select(CONVERSATION_COLUMNS + ", last_inbound_at, last_message_at")
    .eq("status", "bot")
    .lt("last_message_at", iso(t - AUTO_RESOLVE_MS))
    .limit(BATCH);
  if (quietError) throw quietError;
  for (const row of (quiet ?? []) as unknown as (Record<string, string | null>)[]) {
    if (row.last_inbound_at && row.last_inbound_at >= (row.last_message_at as string)) continue; // el último mensaje fue del cliente: lo atiende el re-encolado
    try {
      await transition("auto_resolve", toConversation(row as never), system);
      result.resolved++;
    } catch (e) {
      log.warn("maintenance", "no se pudo resolver", { conversationId: row.id, error: e instanceof Error ? e.message : "error" });
    }
  }

  // T11 — inactividad según el negocio.
  const { data: settings } = await db().from("chatbot_settings").select("business_id, inactivity_close_hours");
  const hoursByBusiness = new Map((settings ?? []).map((s) => [s.business_id as string, s.inactivity_close_hours as number]));
  const { data: stale, error: staleError } = await db()
    .from("conversations")
    .select(CONVERSATION_COLUMNS + ", last_message_at")
    .in("status", ["bot", "resolved"])
    .lt("last_message_at", iso(t - Math.min(DEFAULT_CLOSE_HOURS, ...hoursByBusiness.values()) * 3_600_000))
    .limit(BATCH);
  if (staleError) throw staleError;
  for (const row of (stale ?? []) as unknown as (Record<string, string>)[]) {
    const hours = hoursByBusiness.get(row.business_id) ?? DEFAULT_CLOSE_HOURS;
    if (new Date(row.last_message_at).getTime() >= t - hours * 3_600_000) continue;
    try {
      await transition("close", toConversation(row as never), system, { reason: "inactivity" });
      result.closed++;
    } catch (e) {
      log.warn("maintenance", "no se pudo cerrar", { conversationId: row.id, error: e instanceof Error ? e.message : "error" });
    }
  }

  // Disponibilidad: sin señal del panel en 15 min (o nunca) → no disponible.
  const { data: away, error: awayError } = await db()
    .from("business_members")
    .update({ is_available: false })
    .eq("is_available", true)
    .or(`last_seen_at.is.null,last_seen_at.lt.${iso(t - AVAILABILITY_TTL_MS)}`)
    .select("id");
  if (awayError) throw awayError;
  result.unavailable = away?.length ?? 0;

  // Re-encolado: el último mensaje del cliente lleva más de 2 min sin respuesta.
  if (isChatbotGloballyEnabled()) {
    const { data: waiting, error: waitingError } = await db()
      .from("conversations")
      .select("id, business_id, last_inbound_at, last_message_at")
      .eq("status", "bot")
      .not("last_inbound_at", "is", null)
      .lt("last_inbound_at", iso(t - REQUEUE_AFTER_MS))
      .gte("last_inbound_at", iso(t - AUTO_RESOLVE_MS))
      .limit(REQUEUE_BATCH * 5);
    if (waitingError) throw waitingError;
    const enabled = new Set(((await db().from("chatbot_settings").select("business_id").eq("enabled", true)).data ?? []).map((s) => s.business_id as string));
    for (const c of waiting ?? []) {
      if (result.requeued >= REQUEUE_BATCH) break;
      if (!enabled.has(c.business_id) || (c.last_inbound_at as string) < (c.last_message_at as string)) continue; // la IA ya contestó después
      const { data: last } = await db()
        .from("conversation_messages")
        .select("id, direction, status")
        .eq("conversation_id", c.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!last || last.direction !== "inbound") continue;
      try {
        await enqueueChatbotReply({ conversationId: c.id, triggerMessageId: last.id, waMessageId: `requeue-${last.id}` });
        result.requeued++;
      } catch (e) {
        log.warn("maintenance", "no se pudo re-encolar", { conversationId: c.id, error: e instanceof Error ? e.message : "error" });
      }
    }
  }

  // Retención (07 §19.12, D-10): webhooks crudos 30 días; conversaciones y preguntas sin respuesta 12 meses; intentos de login 1 día.
  result.purged = await purgeExpired(now);
  return result;
}

export const WEBHOOK_RETENTION_DAYS = 30;
export const CONVERSATION_RETENTION_MONTHS = 12;
export const LOGIN_ATTEMPT_RETENTION_MS = 24 * 3600 * 1000;

function monthsAgo(now: Date, months: number): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/** Borra lo vencido. Cada tabla se purga por separado: si una falla, las demás siguen y se avisa en el log. */
export async function purgeExpired(now: Date = new Date()): Promise<number> {
  const steps: { table: string; column: string; before: string }[] = [
    { table: "webhook_events", column: "received_at", before: iso(now.getTime() - WEBHOOK_RETENTION_DAYS * 86_400_000) },
    // La conversación arrastra sus mensajes, eventos y asignaciones (cascada).
    { table: "conversations", column: "last_message_at", before: monthsAgo(now, CONVERSATION_RETENTION_MONTHS) },
    { table: "unanswered_questions", column: "created_at", before: monthsAgo(now, CONVERSATION_RETENTION_MONTHS) },
    { table: "login_attempts", column: "attempted_at", before: iso(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS) },
  ];
  let total = 0;
  for (const step of steps) {
    const { count, error } = await db().from(step.table).delete({ count: "exact" }).lt(step.column, step.before);
    if (error) {
      log.warn("maintenance", "no se pudo purgar", { table: step.table, error: error.message });
      continue;
    }
    total += count ?? 0;
  }
  return total;
}
