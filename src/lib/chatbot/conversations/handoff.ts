import "server-only";
import { after } from "next/server";
import type { ResolvedBusiness } from "@/lib/chatbot/business-resolver";
import type { ChannelSender } from "@/lib/chatbot/channels/types";
import { summarizeConversation } from "@/lib/chatbot/engine/summarize";
import type { ChatbotSettings } from "@/lib/chatbot/settings";
import { renderTemplate } from "@/lib/chatbot/template";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Contact } from "./contacts";
import { describeNextOpening, isWithinHumanHours, nextOpening } from "./hours";
import { logEvent } from "./events";
import { sendReply } from "./outbound";
import { listMessages, type Conversation } from "./service";

/**
 * Derivación a una persona (05 §16.3): aceptar, rechazar y avisar fuera de horario.
 * Cada transición es un `update … where status = <esperado> and version = <leída>`: si otro proceso cambió la
 * conversación en el medio, no se aplica (y no se duplican mensajes).
 */

export const OFFER_VALID_MS = 30 * 60 * 1000;
export const OUT_OF_HOURS_NOTICE_MS = 12 * 60 * 60 * 1000;
export const DECLINE_REPLY = "Sigo por aquí, ¿en qué más te ayudo?";
const ACCEPT_TEXT = new Set(["persona", "humano", "si", "si quiero", "si con una persona", "con una persona", "quiero una persona", "quiero hablar con una persona"]);

export interface HandoffEnv {
  business: ResolvedBusiness;
  settings: ChatbotSettings;
  contact: Contact;
  lastInboundAt: Date | null;
  now?: Date;
  channel?: ChannelSender;
}

export function offerIsValid(conversation: Conversation, now: Date = new Date()): boolean {
  return conversation.status === "bot" && !!conversation.handoffOfferedAt && now.getTime() - new Date(conversation.handoffOfferedAt).getTime() < OFFER_VALID_MS;
}

/** ¿El texto acepta una oferta vigente? («persona», «humano», «sí»). */
export function isHandoffAcceptText(text: string | null | undefined): boolean {
  if (!text) return false;
  const n = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return ACCEPT_TEXT.has(n);
}

/** "Hay atención ahora" = dentro de horario y al menos un operador disponible (05 §16.6). */
export async function humanAttention(businessId: string, settings: ChatbotSettings, timeZone: string, now: Date = new Date()) {
  const { count, error } = await getSupabaseAdmin()
    .from("business_members")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "active")
    .eq("is_available", true);
  if (error) throw error;
  const inHours = isWithinHumanHours(settings.human_hours, timeZone, now);
  const next = nextOpening(settings.human_hours, timeZone, now);
  return {
    inHours,
    operatorsAvailable: count ?? 0,
    available: inHours && (count ?? 0) > 0,
    nextLabel: next ? describeNextOpening(next, timeZone, now) : "cuando el equipo vuelva a atender",
  };
}

const render = (env: HandoffEnv, text: string, nextLabel: string) =>
  renderTemplate(text, { negocio: env.business.name, asistente: env.settings.assistant_name, proximo_horario: nextLabel });

/** T2: el cliente acepta. Pasa a `pending_human` y confirma o avisa que será fuera de horario. */
export async function acceptHandoff(conversation: Conversation, env: HandoffEnv): Promise<"accepted" | "noop"> {
  const now = env.now ?? new Date();
  const { data, error } = await getSupabaseAdmin()
    .from("conversations")
    .update({ status: "pending_human", handoff_requested_at: now.toISOString(), version: conversation.version + 1 })
    .eq("id", conversation.id)
    .eq("business_id", conversation.businessId)
    .eq("status", "bot")
    .eq("version", conversation.version)
    .select("id");
  if (error) throw error;
  if (!data?.length) return "noop"; // otro proceso ya la movió (doble toque del botón)

  await logEvent({ conversationId: conversation.id, businessId: conversation.businessId, type: "handoff_accepted", actorType: "customer", from: "bot", to: "pending_human" });
  const attention = await humanAttention(conversation.businessId, env.settings, env.business.timezone, now);
  const text = attention.available
    ? render(env, env.settings.handoff_confirmed_message, attention.nextLabel)
    : render(env, env.settings.out_of_hours_message, attention.nextLabel);
  await sendReply({ ...conversation, status: "pending_human" }, env.contact, { text, senderType: "system", lastInboundAt: env.lastInboundAt, channel: env.channel });
  if (!attention.available) {
    await getSupabaseAdmin().from("conversations").update({ last_out_of_hours_notice_at: now.toISOString() }).eq("id", conversation.id);
  }

  // Resumen para la persona que tome el caso: en segundo plano, sin bloquear la respuesta al cliente.
  after(async () => {
    try {
      const messages = await listMessages(conversation.businessId, conversation.id, 30);
      const summary = await summarizeConversation({
        businessId: conversation.businessId,
        conversationId: conversation.id,
        settings: env.settings,
        messages: messages.map((m) => ({ sender: m.sender, body: m.body })),
      });
      if (summary) await getSupabaseAdmin().from("conversations").update({ summary }).eq("id", conversation.id);
    } catch (e) {
      console.error("[handoff] resumen", e instanceof Error ? e.message : "error");
    }
  });
  return "accepted";
}

/** T5: el cliente prefiere seguir con el asistente. */
export async function declineHandoff(conversation: Conversation, env: HandoffEnv): Promise<"declined" | "noop"> {
  const { data, error } = await getSupabaseAdmin()
    .from("conversations")
    .update({ handoff_offered_at: null, consecutive_failures: 0, version: conversation.version + 1 })
    .eq("id", conversation.id)
    .eq("business_id", conversation.businessId)
    .eq("status", "bot")
    .eq("version", conversation.version)
    .select("id");
  if (error) throw error;
  if (!data?.length) return "noop";
  await logEvent({ conversationId: conversation.id, businessId: conversation.businessId, type: "handoff_declined", actorType: "customer" });
  await sendReply(conversation, env.contact, { text: DECLINE_REPLY, senderType: "system", lastInboundAt: env.lastInboundAt, channel: env.channel });
  return "declined";
}

/** Botones `handoff:yes` / `handoff:no` (regla 3 del router). Sin IA, de forma determinística. */
export async function handleHandoffButton(conversation: Conversation, env: HandoffEnv, buttonId: string): Promise<void> {
  if (conversation.status !== "bot") return; // ya derivada o cerrada: un toque repetido no hace nada
  const now = env.now ?? new Date();
  if (buttonId === "handoff:no") {
    await declineHandoff(conversation, env);
  } else if (buttonId === "handoff:yes") {
    if (offerIsValid(conversation, now)) {
      await acceptHandoff(conversation, env);
    } else {
      // La oferta venció: se vuelve a ofrecer en lugar de derivar sin que el cliente lo haya pedido ahora.
      await getSupabaseAdmin().from("conversations").update({ handoff_offered_at: now.toISOString() }).eq("id", conversation.id);
      await sendReply(conversation, env.contact, {
        text: render(env, env.settings.handoff_offer_message, ""),
        buttons: true,
        senderType: "system",
        lastInboundAt: env.lastInboundAt,
        channel: env.channel,
      });
    }
  }
}

/** Aviso de fuera de horario a un cliente en `pending_human` (máximo uno cada 12 h por conversación). */
export async function maybeSendOutOfHoursNotice(conversation: Conversation, env: HandoffEnv): Promise<boolean> {
  if (conversation.status !== "pending_human") return false;
  const now = env.now ?? new Date();
  if (conversation.lastOutOfHoursNoticeAt && now.getTime() - new Date(conversation.lastOutOfHoursNoticeAt).getTime() < OUT_OF_HOURS_NOTICE_MS) return false;
  const attention = await humanAttention(conversation.businessId, env.settings, env.business.timezone, now);
  if (attention.available) return false;

  // `where last_out_of_hours_notice_at is …` evita que dos mensajes seguidos manden dos avisos.
  let query = getSupabaseAdmin().from("conversations").update({ last_out_of_hours_notice_at: now.toISOString() }).eq("id", conversation.id);
  query = conversation.lastOutOfHoursNoticeAt ? query.eq("last_out_of_hours_notice_at", conversation.lastOutOfHoursNoticeAt) : query.is("last_out_of_hours_notice_at", null);
  const { data, error } = await query.select("id");
  if (error) throw error;
  if (!data?.length) return false;
  await sendReply(conversation, env.contact, { text: render(env, env.settings.out_of_hours_message, attention.nextLabel), senderType: "system", lastInboundAt: env.lastInboundAt, channel: env.channel });
  return true;
}
