import "server-only";
import type { ChannelSender } from "@/lib/chatbot/channels/types";
import { isChatbotGloballyEnabled } from "@/lib/chatbot/config";
import type { Delivery, TurnContext, TurnDeps } from "@/lib/chatbot/engine/orchestrator";
import { getChatbotSettings } from "@/lib/chatbot/settings";
import { formatFecha, formatHora } from "@/lib/dates";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Contact } from "./contacts";
import { logEvent } from "./events";
import { humanAttention } from "./handoff";
import { sendReply } from "./outbound";
import { toConversation, CONVERSATION_COLUMNS, type Conversation } from "./service";
import type { ResolvedBusiness } from "@/lib/chatbot/business-resolver";

/**
 * Implementación real (base de datos + WhatsApp) de los puertos del orquestador.
 * Una instancia por petición: guarda en memoria lo cargado para entregar la respuesta.
 */

export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_PER_WINDOW = 20;
export const RATE_LIMIT_PER_DAY = 100;
/** Respuestas del bot por conversación y día (07 §19.10). */
export const BOT_REPLIES_PER_DAY = 60;
const LEASE_SECONDS = 90;

const db = () => getSupabaseAdmin();
const ACTIVE = ["scheduled", "rescheduled", "confirmed"];
const STATUS_LABEL: Record<string, string> = { scheduled: "programado", rescheduled: "reprogramado", confirmed: "confirmado" };

interface Loaded {
  conversation: Conversation;
  contact: Contact;
  business: ResolvedBusiness;
  lastInboundAt: Date | null;
  triggerMessageId: string;
}

export function createTurnDeps(options: { channel?: ChannelSender } = {}): TurnDeps {
  const loaded = new Map<string, Loaded>();

  return {
    lock: async (conversationId) => {
      const { data, error } = await db().rpc("try_lock_conversation", { p_conversation_id: conversationId, p_seconds: LEASE_SECONDS });
      if (error) throw error;
      return data === true;
    },
    unlock: async (conversationId) => {
      await db().rpc("unlock_conversation", { p_conversation_id: conversationId });
    },

    async load({ conversationId, triggerMessageId }): Promise<TurnContext | null> {
      const { data: row, error } = await db().from("conversations").select(CONVERSATION_COLUMNS).eq("id", conversationId).maybeSingle();
      if (error) throw error;
      if (!row) return null;
      const conversation = toConversation(row as never);
      const businessId = conversation.businessId;

      const [{ data: contactRow }, { data: biz }, settings, { data: msgs, error: msgsError }] = await Promise.all([
        db().from("chat_contacts").select("id, business_id, channel, external_id, display_name, customer_id, blocked").eq("id", conversation.contactId).eq("business_id", businessId).single(),
        db().from("businesses").select("id, name, address, timezone").eq("id", businessId).single(),
        getChatbotSettings(businessId),
        db().from("conversation_messages").select("id, direction, sender_type, body, content_type, reply_to_message_id, status, created_at").eq("conversation_id", conversationId).eq("business_id", businessId).order("created_at", { ascending: false }).limit(60),
      ]);
      if (msgsError) throw msgsError;
      if (!contactRow || !biz) return null;
      const contact: Contact = { id: contactRow.id, businessId, channel: contactRow.channel, externalId: contactRow.external_id, displayName: contactRow.display_name, customerId: contactRow.customer_id, blocked: contactRow.blocked };
      const business: ResolvedBusiness = biz;

      const messages = (msgs ?? []).slice().reverse();
      // Una respuesta que quedó `queued` (el envío falló y se está reintentando) todavía no le llegó al cliente:
      // no cuenta como "ya respondido" ni cierra el grupo de mensajes pendientes.
      const lastOutboundIdx = messages.map((m) => m.direction === "outbound" && m.status !== "queued").lastIndexOf(true);
      const pending = messages.slice(lastOutboundIdx + 1).filter((m) => m.direction === "inbound");
      const firstPendingIdx = pending.length ? messages.findIndex((m) => m.id === pending[0].id) : messages.length;
      const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");

      const now = new Date();
      const attention = await humanAttention(businessId, settings, business.timezone, now);

      let nextAppointment: string | null = null;
      if (contact.customerId) {
        const { data: appt } = await db()
          .from("appointments")
          .select("starts_at, service, status")
          .eq("business_id", businessId)
          .eq("customer_id", contact.customerId)
          .in("status", ACTIVE)
          .gt("starts_at", now.toISOString())
          .order("starts_at")
          .limit(1)
          .maybeSingle();
        if (appt) {
          const at = new Date(appt.starts_at);
          nextAppointment = `${formatFecha(at, business.timezone)} ${formatHora(at, business.timezone)}${appt.service ? ` · ${appt.service}` : ""} · estado: ${STATUS_LABEL[appt.status] ?? appt.status}`;
        }
      }

      loaded.set(conversationId, { conversation, contact, business, lastInboundAt: lastInbound ? new Date(lastInbound.created_at) : null, triggerMessageId });
      return {
        businessId,
        businessName: business.name,
        address: business.address,
        timeZone: business.timezone,
        channel: conversation.channel,
        settings,
        conversation: { id: conversationId, status: conversation.status, consecutiveFailures: conversation.consecutiveFailures, isFirstReply: lastOutboundIdx === -1 },
        contactBlocked: contact.blocked,
        triggerIsLatest: pending.length > 0 && pending[pending.length - 1].id === triggerMessageId,
        alreadyReplied: messages.some((m) => m.direction === "outbound" && m.sender_type === "bot" && m.reply_to_message_id === triggerMessageId && m.status !== "queued"),
        inbound: pending.slice(-5).map((m) => ({ id: m.id, text: m.body, contentType: m.content_type })),
        history: messages.slice(0, firstPendingIdx).map((m) => ({ sender: m.sender_type, body: m.body })),
        summary: conversation.summary,
        nextAppointment,
        humanAttention: attention.available ? "disponible ahora" : `próxima: ${attention.nextLabel}`,
        nextOpening: attention.nextLabel,
        nowLabel: `${formatFecha(now, business.timezone)} ${formatHora(now, business.timezone)}`,
      };
    },

    /** Límite por contacto: 20 mensajes en 10 min y 100 por día; al pasarse, un aviso y silencio hasta que baje. */
    async rateLimit(ctx) {
      const since = (ms: number) => new Date(Date.now() - ms).toISOString();
      const count = async (ms: number) =>
        (await db().from("conversation_messages").select("id", { count: "exact", head: true }).eq("conversation_id", ctx.conversation.id).eq("direction", "inbound").gte("created_at", since(ms))).count ?? 0;
      const botReplies = async () =>
        (await db().from("conversation_messages").select("id", { count: "exact", head: true }).eq("conversation_id", ctx.conversation.id).eq("direction", "outbound").eq("sender_type", "bot").gte("created_at", since(24 * 3600 * 1000))).count ?? 0;
      const windowOver = (await count(RATE_LIMIT_WINDOW_MS)) > RATE_LIMIT_PER_WINDOW;
      const dayOver = (await count(24 * 3600 * 1000)) > RATE_LIMIT_PER_DAY || (await botReplies()) >= BOT_REPLIES_PER_DAY;
      if (!windowOver && !dayOver) return "ok";
      // Un aviso por ventana de 10 min; si solo se pasó el tope diario, un solo aviso al día.
      const { count: notified } = await db().from("conversation_events").select("id", { count: "exact", head: true }).eq("conversation_id", ctx.conversation.id).eq("type", "rate_limited").gte("created_at", since(windowOver ? RATE_LIMIT_WINDOW_MS : 24 * 3600 * 1000));
      if (notified) return "silent";
      await logEvent({ conversationId: ctx.conversation.id, businessId: ctx.businessId, type: "rate_limited", actorType: "system" });
      return "notify";
    },

    async deliver(ctx, delivery: Delivery) {
      const l = loaded.get(ctx.conversation.id);
      if (!l) throw new Error("Contexto del turno no cargado");
      const { conversation, contact } = l;

      const result = await sendReply(conversation, contact, {
        text: delivery.text,
        buttons: delivery.handoffButtons,
        senderType: delivery.source === "system" ? "system" : "bot",
        replyToMessageId: l.triggerMessageId,
        lastInboundAt: l.lastInboundAt,
        ai: { source: delivery.source, used_source_ids: delivery.usedSourceIds },
        channel: options.channel,
      });
      if (result.status === "duplicate") return; // ya se respondió a este mensaje: no se repiten los efectos

      const update: Record<string, unknown> = { consecutive_failures: delivery.failures };
      if (delivery.handoffOffer) {
        update.handoff_offered_at = new Date().toISOString();
        update.handoff_reason = delivery.handoffOffer.reason;
      }
      const { error } = await db().from("conversations").update(update).eq("id", conversation.id);
      if (error) throw error;

      if (delivery.unanswered) {
        await db().from("unanswered_questions").insert({
          business_id: ctx.businessId,
          conversation_id: conversation.id,
          message_id: l.triggerMessageId,
          question: delivery.unanswered.question.slice(0, 1000),
          reason: delivery.unanswered.reason,
        });
      }
      for (const e of delivery.events) {
        await logEvent({ conversationId: conversation.id, businessId: ctx.businessId, type: e.type, actorType: "bot", payload: e.payload });
      }
    },
  };
}

/** ¿El chatbot está disponible para procesar turnos de este negocio? (interruptor global + configuración) */
export async function chatbotActiveFor(businessId: string): Promise<boolean> {
  if (!isChatbotGloballyEnabled()) return false;
  return (await getChatbotSettings(businessId)).enabled;
}
