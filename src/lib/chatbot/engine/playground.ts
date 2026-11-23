import "server-only";
import { ServiceError } from "@/lib/appointments/service";
import { resolveModel } from "@/lib/chatbot/config";
import { describeNextOpening, isWithinHumanHours, nextOpening } from "@/lib/chatbot/conversations/hours";
import { getChatbotSettings } from "@/lib/chatbot/settings";
import { computeCostUsd } from "@/lib/chatbot/usage/pricing";
import { formatFecha, formatHora } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { runChatbotTurn, MAX_INPUT_CHARS, type TurnDeps, type TurnContext } from "./orchestrator";

export interface PlaygroundMessage {
  role: "user" | "assistant";
  text: string;
}

export const PLAYGROUND_MAX_MESSAGES = 20;
/** Turnos de la zona de pruebas por negocio y día (07 §19.10). Se cuentan los que llegaron a la IA (los que cuestan). */
export const PLAYGROUND_MAX_TURNS_PER_DAY = 100;

/**
 * Zona de pruebas (04 §14.7): el mismo `runChatbotTurn` en modo `dryRun` — sin canal, sin conversación persistida,
 * con el uso registrado como `playground`. `messages` termina siempre en un mensaje del cliente.
 */
export async function runPlayground(
  businessId: string,
  messages: PlaygroundMessage[],
  overrides: Partial<TurnDeps> = {},
  /** `skipDailyLimit` y `nextAppointment` son para el ejecutor de evaluaciones (no se exponen en el panel). */
  options: { skipDailyLimit?: boolean; nextAppointment?: string | null } = {},
) {
  if (messages.length === 0 || messages.length > PLAYGROUND_MAX_MESSAGES) throw new ServiceError("Escribe un mensaje para probar");
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.text.trim()) throw new ServiceError("El último mensaje debe ser del cliente");
  if (messages.some((m) => m.text.length > MAX_INPUT_CHARS)) throw new ServiceError(`Cada mensaje admite hasta ${MAX_INPUT_CHARS} caracteres`);

  const { count: usedToday, error: usageError } = options.skipDailyLimit
    ? { count: 0, error: null }
    : await getSupabaseAdmin()
        .from("chatbot_usage")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("operation", "playground")
        .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString());
  if (usageError) throw usageError;
  if ((usedToday ?? 0) >= PLAYGROUND_MAX_TURNS_PER_DAY) {
    throw new ServiceError(`Llegaste al máximo de ${PLAYGROUND_MAX_TURNS_PER_DAY} pruebas por día. Vuelve a intentar mañana.`);
  }

  const [settings, bizRes] = await Promise.all([
    getChatbotSettings(businessId),
    getSupabaseAdmin().from("businesses").select("name, address, timezone").eq("id", businessId).single(),
  ]);
  if (bizRes.error) throw bizRes.error;
  const biz = bizRes.data;
  try {
    resolveModel(settings.llm_model);
  } catch (error) {
    throw new ServiceError(error instanceof Error ? error.message.replace("Falta la variable de entorno CHATBOT_DEFAULT_MODEL.", "Falta configurar el modelo por defecto del servidor (CHATBOT_DEFAULT_MODEL).") : "Modelo no disponible");
  }

  const now = new Date();
  const hours = settings.human_hours;
  const next = nextOpening(hours, biz.timezone, now);
  const nextLabel = next ? describeNextOpening(next, biz.timezone, now) : "cuando el equipo vuelva a atender";
  const ctx: TurnContext = {
    businessId,
    businessName: biz.name,
    address: biz.address,
    timeZone: biz.timezone,
    channel: "whatsapp",
    settings,
    conversation: { id: "playground", status: "bot", consecutiveFailures: 0, isFirstReply: messages.length === 1 },
    contactBlocked: false,
    triggerIsLatest: true,
    alreadyReplied: false,
    inbound: [{ id: "playground", text: last.text, contentType: "text" }],
    history: messages.slice(0, -1).map((m) => ({ sender: m.role === "user" ? ("customer" as const) : ("bot" as const), body: m.text })),
    summary: null,
    nextAppointment: options.nextAppointment ?? null,
    humanAttention: isWithinHumanHours(hours, biz.timezone, now) ? "disponible ahora" : `próxima: ${nextLabel}`,
    nextOpening: nextLabel,
    nowLabel: `${formatFecha(now, biz.timezone)} ${formatHora(now, biz.timezone)}`,
  };

  const result = await runChatbotTurn(
    { conversationId: "playground", triggerMessageId: "playground", dryRun: true },
    { load: async () => ctx, deliver: async () => {}, ...overrides },
  );
  if (result.outcome !== "sent") return { reply: null as string | null, reason: result.reason };
  const debug = result.debug!;
  return {
    reply: result.delivery.text,
    handoffButtons: result.delivery.handoffButtons,
    delivery: result.delivery,
    debug,
    costUsd: debug.usage && debug.model ? computeCostUsd(debug.model, debug.usage) : 0,
  };
}
