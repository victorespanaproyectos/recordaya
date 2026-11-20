import "server-only";
import { handleCustomerReply } from "@/lib/appointments/replies";
import { parseReplyIntent } from "@/lib/appointments/intent";
import { resolveBusiness } from "@/lib/chatbot/business-resolver";
import { isChatbotGloballyEnabled, isPhoneAllowedForChatbot } from "@/lib/chatbot/config";
import { upsertContact } from "@/lib/chatbot/conversations/contacts";
import { logEvent } from "@/lib/chatbot/conversations/events";
import { handleHandoffButton, isHandoffAcceptText, maybeSendOutOfHoursNotice, offerIsValid, type HandoffEnv } from "@/lib/chatbot/conversations/handoff";
import { appendInbound, getOrOpenConversation, toConversation, CONVERSATION_COLUMNS } from "@/lib/chatbot/conversations/service";
import { enqueueChatbotReply } from "@/lib/chatbot/jobs";
import { getChatbotSettings } from "@/lib/chatbot/settings";
import { parseStrictReplyIntent } from "@/lib/chatbot/strict-intent";
import { log } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Enrutamiento de mensajes entrantes (02 §5). Cada mensaje sigue exactamente UNA ruta:
 *  - legacy:   `handleCustomerReply` como siempre (chatbot apagado, negocio no resuelto, teléfono fuera de la lista…).
 *  - reminder: respuesta a un recordatorio → `handleCustomerReply`.
 *  - human:    la conversación está con una persona → se guarda, sin respuesta automática.
 *  - chatbot:  se guarda y se encola `chatbot-reply` (o se resuelve un botón de derivación).
 * Un fallo del router fuera de la ruta legacy se registra y CAE a legacy: nunca se pierde la lógica de recordatorios.
 */

export interface InboundContext {
  inboundId: string;
  waMessageId: string;
  from: string;
  text: string | null;
  replyTo: string | null;
  buttonId: string | null;
  type: string;
  phoneNumberId: string | null;
  profileName: string | null;
  receivedAt: Date;
}

export type Route = "legacy" | "reminder" | "human" | "chatbot";
export interface RouteResult {
  route: Route;
  /** Motivo de la ruta (para pruebas y registros). */
  reason?: string;
}

export const REMINDER_KINDS = ["reminder_24h", "reminder_2h", "confirmation", "reschedule"];
const RECENT_REMINDER_MS = 26 * 60 * 60 * 1000;
const ACTIVE = ["scheduled", "rescheduled", "confirmed"];

const db = () => getSupabaseAdmin();

const legacy = (input: InboundContext) =>
  handleCustomerReply({ inboundId: input.inboundId, fromPhone: input.from, text: input.text, replyTo: input.replyTo });

/** Tipo de contenido que se guarda en la conversación. */
const contentTypeOf = (input: InboundContext) => (input.type === "interactive" || input.type === "button" ? "text" : input.type);

/** ¿El mensaje citado es un recordatorio/confirmación nuestro? */
async function quotedReminder(waMessageId: string | null): Promise<{ id: string; kind: string } | null> {
  if (!waMessageId) return null;
  const { data, error } = await db().from("messages").select("id, kind").eq("wa_message_id", waMessageId).maybeSingle();
  if (error) throw error;
  return data && REMINDER_KINDS.includes(data.kind) ? data : null;
}

/** Regla 2: se le envió un recordatorio/confirmación hace menos de 26 h y tiene un turno activo futuro. */
async function hasRecentReminderForActiveAppointment(businessId: string, phone: string, now = Date.now()): Promise<boolean> {
  const since = new Date(now - RECENT_REMINDER_MS).toISOString();
  const { count, error } = await db()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("to_phone", phone)
    .in("kind", REMINDER_KINDS)
    .gte("sent_at", since);
  if (error) throw error;
  if (!count) return false;

  const { data, error: apptError } = await db()
    .from("appointments")
    .select("id, customers!inner(phone)")
    .eq("business_id", businessId)
    .eq("customers.phone", phone)
    .in("status", ACTIVE)
    .gt("starts_at", new Date(now).toISOString())
    .limit(1);
  if (apptError) throw apptError;
  return (data?.length ?? 0) > 0;
}

/** Ruta legacy: además de contestar como siempre, si el contacto tiene una conversación abierta el operador debe verla (05 §16.11). */
async function mirrorIntoOpenConversation(businessId: string, input: InboundContext): Promise<void> {
  const { data: contact } = await db().from("chat_contacts").select("id").eq("business_id", businessId).eq("channel", "whatsapp").eq("external_id", input.from).maybeSingle();
  if (!contact) return;
  const { data: row } = await db().from("conversations").select(CONVERSATION_COLUMNS).eq("business_id", businessId).eq("contact_id", contact.id).neq("status", "closed").maybeSingle();
  if (!row) return;
  await appendInbound(toConversation(row as never), { inboundId: input.inboundId, text: input.text, contentType: contentTypeOf(input) });
}

export async function routeInboundMessage(input: InboundContext): Promise<RouteResult> {
  // ── Regla 0: todo lo que no es del chatbot sigue exactamente como antes ──
  let business;
  try {
    business = await resolveBusiness(input.phoneNumberId);
  } catch (error) {
    log.error("router", error, { step: "resolve_business" });
    await legacy(input);
    return { route: "legacy", reason: "router_error" };
  }
  if (!business) {
    await legacy(input);
    return { route: "legacy", reason: "business_not_resolved" };
  }
  const enabledGlobally = isChatbotGloballyEnabled();
  const allowed = isPhoneAllowedForChatbot(input.from);
  let settings;
  try {
    settings = enabledGlobally && allowed ? await getChatbotSettings(business.id) : null;
  } catch (error) {
    log.error("router", error, { step: "settings" });
    await legacy(input);
    return { route: "legacy", reason: "router_error" };
  }
  if (!settings?.enabled) {
    try {
      await mirrorIntoOpenConversation(business.id, input);
    } catch (error) {
      log.error("router", error, { step: "mirror" }); // nunca debe impedir la respuesta legacy
    }
    await legacy(input);
    return { route: "legacy", reason: !enabledGlobally ? "kill_switch" : !allowed ? "not_in_allowlist" : "chatbot_disabled" };
  }

  // ── Rutas con chatbot: un fallo cae a legacy (si todavía no se ejecutó) ──
  let legacyDone = false;
  try {
    const contact = await upsertContact(business.id, "whatsapp", input.from, input.profileName);
    const conversation0 = await getOrOpenConversation(business.id, contact.id, "whatsapp");
    const appended = await appendInbound(conversation0, { inboundId: input.inboundId, text: input.text, contentType: contentTypeOf(input) });
    if (appended.duplicate) return { route: "chatbot", reason: "duplicate" };
    const conversation = appended.conversation;
    const env: HandoffEnv = { business, settings, contact, lastInboundAt: input.receivedAt };

    // Regla 1: cita un recordatorio nuestro.
    const quoted = await quotedReminder(input.replyTo);
    if (quoted) {
      legacyDone = true;
      await legacy(input);
      await logEvent({ conversationId: conversation.id, businessId: business.id, type: "reminder_reply_routed", actorType: "customer", payload: { quoted: quoted.id } });
      // 5.4: una pregunta citando un recordatorio recibe el aviso 1/2 Y la respuesta del chatbot.
      if (settings.answer_questions_on_reminder_replies && conversation.status === "bot" && input.text && parseReplyIntent(input.text) === "unknown") {
        await enqueueChatbotReply({ conversationId: conversation.id, triggerMessageId: appended.id, waMessageId: input.waMessageId });
      }
      return { route: "reminder", reason: "quoted" };
    }
    // Regla 2: «1», «no puedo»… sin citar, con un recordatorio reciente.
    if (parseStrictReplyIntent(input.text) !== "unknown" && (await hasRecentReminderForActiveAppointment(business.id, input.from))) {
      legacyDone = true;
      await legacy(input);
      await logEvent({ conversationId: conversation.id, businessId: business.id, type: "reminder_reply_routed", actorType: "customer", payload: { strict: true } });
      return { route: "reminder", reason: "strict" };
    }
    // Regla 3: botones de derivación (sin IA).
    if (input.buttonId?.startsWith("handoff:")) {
      await handleHandoffButton(conversation, env, input.buttonId);
      return { route: "chatbot", reason: "handoff_button" };
    }
    // Regla 3b: «persona», «humano» o «sí» con una oferta vigente (alternativa si los botones no se mostraron).
    if (offerIsValid(conversation) && isHandoffAcceptText(input.text)) {
      await handleHandoffButton(conversation, env, "handoff:yes");
      return { route: "chatbot", reason: "handoff_text" };
    }
    // Regla 4: con una persona (o esperando a una): se guarda, sin respuesta automática.
    if (conversation.status === "pending_human" || conversation.status === "human") {
      await maybeSendOutOfHoursNotice(conversation, env);
      return { route: "human" };
    }
    // Regla 5: el chatbot responde.
    await enqueueChatbotReply({ conversationId: conversation.id, triggerMessageId: appended.id, waMessageId: input.waMessageId });
    return { route: "chatbot" };
  } catch (error) {
    log.error("router", error, { step: "chatbot_route", legacyDone });
    if (!legacyDone) await legacy(input);
    return { route: "legacy", reason: "router_error" };
  }
}
