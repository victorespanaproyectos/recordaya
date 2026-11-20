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

/**
 * Zona de pruebas (04 §14.7): el mismo `runChatbotTurn` en modo `dryRun` — sin canal, sin conversación persistida,
 * con el uso registrado como `playground`. `messages` termina siempre en un mensaje del cliente.
 */
export async function runPlayground(businessId: string, messages: PlaygroundMessage[], overrides: Partial<TurnDeps> = {}) {
  if (messages.length === 0 || messages.length > PLAYGROUND_MAX_MESSAGES) throw new ServiceError("Escribe un mensaje para probar");
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.text.trim()) throw new ServiceError("El último mensaje debe ser del cliente");
  if (messages.some((m) => m.text.length > MAX_INPUT_CHARS)) throw new ServiceError(`Cada mensaje admite hasta ${MAX_INPUT_CHARS} caracteres`);

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
    nextAppointment: null,
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
