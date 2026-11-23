import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Channel } from "./contacts";
import { logEvent, type ConversationStatus } from "./events";

export interface Conversation {
  id: string;
  businessId: string;
  contactId: string;
  channel: Channel;
  status: ConversationStatus;
  assignedMemberId: string | null;
  consecutiveFailures: number;
  handoffOfferedAt: string | null;
  lastOutOfHoursNoticeAt: string | null;
  unreadCount: number;
  summary: string | null;
  version: number;
  createdAt: string;
}

interface Row {
  id: string;
  business_id: string;
  contact_id: string;
  channel: Channel;
  status: ConversationStatus;
  assigned_member_id: string | null;
  consecutive_failures: number;
  handoff_offered_at: string | null;
  last_out_of_hours_notice_at: string | null;
  unread_count: number;
  summary: string | null;
  version: number;
  created_at: string;
}

export const CONVERSATION_COLUMNS =
  "id, business_id, contact_id, channel, status, assigned_member_id, consecutive_failures, handoff_offered_at, last_out_of_hours_notice_at, unread_count, summary, version, created_at";

export const toConversation = (r: Row): Conversation => ({
  id: r.id, businessId: r.business_id, contactId: r.contact_id, channel: r.channel, status: r.status, assignedMemberId: r.assigned_member_id,
  consecutiveFailures: r.consecutive_failures, handoffOfferedAt: r.handoff_offered_at, lastOutOfHoursNoticeAt: r.last_out_of_hours_notice_at,
  unreadCount: r.unread_count, summary: r.summary, version: r.version, createdAt: r.created_at,
});

const db = () => getSupabaseAdmin();

async function findOpen(businessId: string, contactId: string, channel: Channel): Promise<Row | null> {
  const { data, error } = await db()
    .from("conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .eq("channel", channel)
    .neq("status", "closed")
    .maybeSingle<Row>();
  if (error) throw error;
  return data;
}

/** Conversación abierta del contacto, o una nueva en estado `bot`. Dos entrantes simultáneos terminan en la misma. */
export async function getOrOpenConversation(businessId: string, contactId: string, channel: Channel): Promise<Conversation> {
  const open = await findOpen(businessId, contactId, channel);
  if (open) return toConversation(open);

  const { data, error } = await db()
    .from("conversations")
    .insert({ business_id: businessId, contact_id: contactId, channel, status: "bot" })
    .select(CONVERSATION_COLUMNS)
    .single<Row>();
  if (error?.code === "23505") {
    // Otro proceso la abrió entre el select y el insert (índice único parcial): se usa esa.
    const winner = await findOpen(businessId, contactId, channel);
    if (winner) return toConversation(winner);
  }
  if (error) throw error;
  await logEvent({ conversationId: data.id, businessId, type: "opened", actorType: "customer", to: "bot" });
  return toConversation(data);
}

export async function getConversation(businessId: string, id: string): Promise<Conversation | null> {
  const { data, error } = await db().from("conversations").select(CONVERSATION_COLUMNS).eq("id", id).eq("business_id", businessId).maybeSingle<Row>();
  if (error) throw error;
  return data ? toConversation(data) : null;
}

export interface MessageRef {
  id: string;
  duplicate: boolean;
  /** Solo en duplicados: cómo quedó el mensaje que ya existía. */
  existing?: { status: string; body: string | null; waMessageId: string | null };
}

export interface InboundInput {
  /** `inbound_messages.id`: la clave de idempotencia. */
  inboundId: string;
  text: string | null;
  contentType: string;
}

const MAX_APPEND_ATTEMPTS = 25;

/**
 * Guarda el mensaje del cliente. Idempotente por `inbound_message_id`: reprocesar el mismo entrante no duplica
 * ni vuelve a contar como no leído. Un cliente que escribe en una conversación `resolved` la reabre (`bot`).
 */
export async function appendInbound(conversation: Conversation, input: InboundInput): Promise<MessageRef & { conversation: Conversation }> {
  const { data, error } = await db()
    .from("conversation_messages")
    .insert({
      conversation_id: conversation.id,
      business_id: conversation.businessId,
      direction: "inbound",
      sender_type: "customer",
      content_type: input.contentType,
      body: input.text?.slice(0, 4096) ?? null,
      inbound_message_id: input.inboundId,
      status: "delivered",
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    const { data: existing } = await db().from("conversation_messages").select("id").eq("inbound_message_id", input.inboundId).single();
    return { id: existing!.id, duplicate: true, conversation };
  }
  if (error) throw error;

  // Contador sin pérdidas: la actualización solo se aplica si nadie cambió la conversación entre la lectura y la
  // escritura (mismo unread_count y misma versión). Si dos mensajes llegan a la vez, el segundo relee y reintenta.
  let current = conversation;
  let updated: Row | null = null;
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS && !updated; attempt++) {
    const now = new Date().toISOString();
    const reopen = current.status === "resolved";
    const { data: row, error: updateError } = await db()
      .from("conversations")
      .update({
        last_inbound_at: now,
        last_message_at: now,
        unread_count: current.unreadCount + 1,
        ...(reopen && { status: "bot", resolved_at: null, resolved_by: null, version: current.version + 1 }),
      })
      .eq("id", current.id)
      .eq("unread_count", current.unreadCount)
      .eq("version", current.version)
      .select(CONVERSATION_COLUMNS)
      .maybeSingle<Row>();
    if (updateError) throw updateError;
    if (row) {
      updated = row;
      if (reopen) await logEvent({ conversationId: current.id, businessId: current.businessId, type: "reopened", actorType: "customer", from: "resolved", to: "bot" });
    } else {
      // Pequeña espera aleatoria para que los competidores no vuelvan a chocar al mismo tiempo.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 40));
      const { data: fresh, error: freshError } = await db().from("conversations").select(CONVERSATION_COLUMNS).eq("id", current.id).single<Row>();
      if (freshError) throw freshError;
      current = toConversation(fresh);
    }
  }
  if (!updated) throw new Error("No se pudo actualizar la conversación: demasiada concurrencia");
  return { id: data.id, duplicate: false, conversation: toConversation(updated) };
}

export interface OutboundInput {
  senderType: "bot" | "agent" | "system";
  body: string;
  /** Mensaje del cliente al que responde: el índice único impide dos respuestas del bot al mismo mensaje. */
  replyToMessageId?: string | null;
  senderMemberId?: string | null;
  clientRequestId?: string | null;
  contentType?: "text" | "interactive";
  ai?: Record<string, unknown> | null;
}

/** Registra la respuesta como `queued` ANTES de enviarla (idempotencia); `duplicate` si ya existía una para ese mensaje. */
export async function appendOutbound(conversation: Conversation, input: OutboundInput): Promise<MessageRef> {
  const { data, error } = await db()
    .from("conversation_messages")
    .insert({
      conversation_id: conversation.id,
      business_id: conversation.businessId,
      direction: "outbound",
      sender_type: input.senderType,
      sender_member_id: input.senderMemberId ?? null,
      content_type: input.contentType ?? "text",
      body: input.body.slice(0, 4096),
      reply_to_message_id: input.replyToMessageId ?? null,
      client_request_id: input.clientRequestId ?? null,
      ai: input.ai ?? null,
      status: "queued",
    })
    .select("id")
    .single();
  if (error?.code === "23505") {
    const { data: existing } = await db()
      .from("conversation_messages")
      .select("id, status, body, wa_message_id")
      .eq("conversation_id", conversation.id)
      .or(`reply_to_message_id.eq.${input.replyToMessageId ?? "00000000-0000-0000-0000-000000000000"},client_request_id.eq.${input.clientRequestId ?? "none"}`)
      .eq("direction", "outbound")
      .limit(1)
      .maybeSingle();
    if (existing) return { id: existing.id, duplicate: true, existing: { status: existing.status, body: existing.body, waMessageId: existing.wa_message_id } };
  }
  if (error) throw error;
  await db().from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversation.id);
  return { id: data.id, duplicate: false };
}

/** Marca el envío aceptado por WhatsApp. */
export async function markOutboundSent(messageId: string, waMessageId: string): Promise<void> {
  const { error } = await db().from("conversation_messages").update({ status: "accepted", wa_message_id: waMessageId, sent_at: new Date().toISOString() }).eq("id", messageId);
  if (error) throw error;
}

export async function markOutboundFailed(messageId: string, error: unknown): Promise<void> {
  const info = error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
  await db().from("conversation_messages").update({ status: "failed", failed_at: new Date().toISOString(), error: info }).eq("id", messageId);
}

export interface StoredMessage {
  id: string;
  direction: "inbound" | "outbound";
  sender: "customer" | "bot" | "agent" | "system";
  body: string | null;
  contentType: string;
  status: string;
  createdAt: string;
}

/** Últimos mensajes de la conversación, del más antiguo al más nuevo. */
export async function listMessages(businessId: string, conversationId: string, limit = 50): Promise<StoredMessage[]> {
  const { data, error } = await db()
    .from("conversation_messages")
    .select("id, direction, sender_type, body, content_type, status, created_at")
    .eq("conversation_id", conversationId)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse().map((m) => ({ id: m.id, direction: m.direction, sender: m.sender_type, body: m.body, contentType: m.content_type, status: m.status, createdAt: m.created_at }));
}
