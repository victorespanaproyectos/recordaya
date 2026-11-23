import "server-only";
import { ServiceError } from "@/lib/appointments/service";
import { can } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import type { ChannelSender } from "@/lib/chatbot/channels/types";
import { ChannelSendError } from "@/lib/chatbot/channels/types";
import { whatsappChannel } from "@/lib/chatbot/channels/whatsapp";
import { getChatbotSettings } from "@/lib/chatbot/settings";
import { sendTemplate } from "@/lib/whatsapp/client";
import { reopenTemplateName, retomarConversacionParams } from "@/lib/whatsapp/templates";
import { renderTemplate } from "@/lib/chatbot/template";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Contact } from "./contacts";
import { logEvent } from "./events";
import { DECLINE_REPLY } from "./handoff";
import { sendReply } from "./outbound";
import { appendOutbound, getConversation, markOutboundFailed, markOutboundSent, type Conversation } from "./service";
import { STALE, transition } from "./state-machine";

/**
 * Acciones del equipo sobre una conversación (T-09.3 a T-09.5). Reglas (06 §3.2):
 *  - tomar, derivar y marcar como leída: cualquier miembro activo;
 *  - liberar, devolver a la IA, resolver y escribir: quien la tiene asignada, o un admin (escribir: solo el asignado);
 *  - cerrar: un admin, o el asignado si está en atención humana; reasignar: admin.
 * El `business_id` siempre viene de la sesión, nunca de un formulario.
 */

const db = () => getSupabaseAdmin();
export const WINDOW_MS = 24 * 60 * 60 * 1000;

async function load(actor: Member, conversationId: string): Promise<Conversation> {
  const conv = await getConversation(actor.businessId, conversationId);
  if (!conv) throw new ServiceError("La conversación no existe", 404);
  return conv;
}

const isAdmin = (actor: Member) => can(actor.role, "conversation.reassign_or_close_any");
const isAssignee = (actor: Member, conv: Conversation) => !!actor.id && conv.assignedMemberId === actor.id;
const actorOf = (actor: Member) => ({ type: "member" as const, memberId: actor.id });

function assertAssigneeOrAdmin(actor: Member, conv: Conversation) {
  if (!isAssignee(actor, conv) && !isAdmin(actor)) throw new ServiceError("Solo quien la tiene asignada o un admin puede hacer eso", 403);
}

interface ReplyEnv {
  contact: Contact;
  lastInboundAt: Date | null;
}
async function replyEnv(conv: Conversation): Promise<ReplyEnv> {
  const [{ data: c }, { data: last }] = await Promise.all([
    db().from("chat_contacts").select("id, business_id, channel, external_id, display_name, customer_id, blocked").eq("id", conv.contactId).eq("business_id", conv.businessId).single(),
    db().from("conversation_messages").select("created_at").eq("conversation_id", conv.id).eq("direction", "inbound").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const contact: Contact = { id: c!.id, businessId: conv.businessId, channel: c!.channel, externalId: c!.external_id, displayName: c!.display_name, customerId: c!.customer_id, blocked: c!.blocked };
  return { contact, lastInboundAt: last ? new Date(last.created_at) : null };
}

/** Aviso opcional al cliente: si no se puede enviar (ventana cerrada…) no deshace la acción, que ya se aplicó. */
async function notifyCustomer(conv: Conversation, text: string, channel?: ChannelSender) {
  try {
    const env = await replyEnv(conv);
    await sendReply(conv, env.contact, { text, senderType: "system", lastInboundAt: env.lastInboundAt, channel });
  } catch (error) {
    console.error("[operator] aviso al cliente", error instanceof Error ? error.message : "error");
  }
}

/** T4 · Tomar. El operador debe estar disponible y bajo su máximo de conversaciones; un admin puede excederlo. */
export async function claimConversation(actor: Member, conversationId: string, expectedVersion?: number): Promise<Conversation> {
  if (!actor.id) throw new ServiceError("Entra con un usuario del equipo para tomar conversaciones", 403);
  const conv = await load(actor, conversationId);
  if (conv.status === "human") throw new ServiceError("Otro operador ya tomó esta conversación", 409);

  const { data: member, error } = await db().from("business_members").select("is_available, max_concurrent, status").eq("id", actor.id).eq("business_id", actor.businessId).single();
  if (error) throw error;
  if (member.status !== "active") throw new ServiceError("Tu usuario no está activo", 403);
  if (!isAdmin(actor)) {
    if (!member.is_available) throw new ServiceError("Actívate como «Disponible» para tomar conversaciones", 409);
    const { count } = await db().from("conversations").select("id", { count: "exact", head: true }).eq("business_id", actor.businessId).eq("assigned_member_id", actor.id).eq("status", "human");
    if ((count ?? 0) >= member.max_concurrent) throw new ServiceError(`Ya tienes ${member.max_concurrent} conversaciones activas (tu máximo)`, 409);
  }
  const taken = await transition("claim", conv, actorOf(actor), { assignTo: actor.id, expectedVersion });
  await db().from("conversations").update({ unread_count: 0 }).eq("id", taken.id);
  return { ...taken, unreadCount: 0 };
}

/** T6 · Liberar: vuelve a la cola. */
export async function releaseConversation(actor: Member, conversationId: string, expectedVersion?: number): Promise<Conversation> {
  const conv = await load(actor, conversationId);
  assertAssigneeOrAdmin(actor, conv);
  return transition("release", conv, actorOf(actor), { expectedVersion });
}

/** T7 · Devolver a la IA (con aviso opcional al cliente). */
export async function returnToBot(actor: Member, conversationId: string, opts: { notify?: boolean; expectedVersion?: number } = {}): Promise<Conversation> {
  const conv = await load(actor, conversationId);
  assertAssigneeOrAdmin(actor, conv);
  const result = await transition("return_to_bot", conv, actorOf(actor), { expectedVersion: opts.expectedVersion });
  if (opts.notify) await notifyCustomer(result, DECLINE_REPLY);
  return result;
}

/** T8 · Resolver (con el mensaje de cierre configurado, si se pide y existe). */
export async function resolveConversation(actor: Member, conversationId: string, opts: { notify?: boolean; expectedVersion?: number } = {}): Promise<Conversation> {
  const conv = await load(actor, conversationId);
  assertAssigneeOrAdmin(actor, conv);
  const result = await transition("resolve", conv, actorOf(actor), { expectedVersion: opts.expectedVersion });
  if (opts.notify) {
    const settings = await getChatbotSettings(conv.businessId);
    if (settings.closing_message) {
      const { data: biz } = await db().from("businesses").select("name").eq("id", conv.businessId).single();
      await notifyCustomer(result, renderTemplate(settings.closing_message, { negocio: biz?.name, asistente: settings.assistant_name }));
    }
  }
  return result;
}

/** T12 · Cerrar: un admin, o el asignado mientras está en atención humana. */
export async function closeConversation(actor: Member, conversationId: string, expectedVersion?: number): Promise<Conversation> {
  const conv = await load(actor, conversationId);
  if (!isAdmin(actor) && !(conv.status === "human" && isAssignee(actor, conv))) {
    throw new ServiceError("Solo un admin, o quien la tiene asignada, puede cerrarla", 403);
  }
  return transition("close", conv, actorOf(actor), { expectedVersion });
}

/** T3 · Derivar a la cola una conversación que atiende la IA. */
export async function handoffConversation(actor: Member, conversationId: string, expectedVersion?: number): Promise<Conversation> {
  const conv = await load(actor, conversationId);
  return transition("request_handoff", conv, actorOf(actor), { expectedVersion });
}

/** T5 (miembro) · Devolver una conversación en cola a la IA. */
export async function declineHandoffByMember(actor: Member, conversationId: string, expectedVersion?: number): Promise<Conversation> {
  const conv = await load(actor, conversationId);
  return transition("decline_handoff", conv, actorOf(actor), { expectedVersion });
}

export async function markRead(actor: Member, conversationId: string): Promise<void> {
  await load(actor, conversationId);
  const { error } = await db().from("conversations").update({ unread_count: 0 }).eq("id", conversationId).eq("business_id", actor.businessId);
  if (error) throw error;
}

/**
 * Reasignación (admin): libera y asigna a otro miembro sin pasar por la cola. No se usa una función SQL atómica
 * (habría exigido una migración 0012); la garantía de "una sola asignación abierta" la da el índice único parcial,
 * y la actualización de la conversación está protegida por estado, asignado y versión.
 */
export async function reassignConversation(actor: Member, conversationId: string, toMemberId: string, expectedVersion?: number): Promise<Conversation> {
  if (!isAdmin(actor)) throw new ServiceError("Solo un admin puede reasignar", 403);
  const conv = await load(actor, conversationId);
  if (conv.status !== "human" || !conv.assignedMemberId) throw new ServiceError("Solo se reasignan conversaciones en atención humana", 409);
  if (conv.assignedMemberId === toMemberId) return conv;
  if (expectedVersion !== undefined && expectedVersion !== conv.version) throw new ServiceError(STALE, 409);

  const { data: target } = await db().from("business_members").select("id, status").eq("id", toMemberId).eq("business_id", actor.businessId).maybeSingle();
  if (!target || target.status !== "active") throw new ServiceError("El miembro no existe o no está activo", 404);

  const now = new Date().toISOString();
  const closeOld = await db().from("conversation_assignments").update({ released_at: now, release_reason: "reassigned" }).eq("conversation_id", conv.id).is("released_at", null);
  if (closeOld.error) throw closeOld.error;
  const moved = await db()
    .from("conversations")
    .update({ assigned_member_id: toMemberId, assigned_at: now, version: conv.version + 1 })
    .eq("id", conv.id)
    .eq("business_id", conv.businessId)
    .eq("status", "human")
    .eq("assigned_member_id", conv.assignedMemberId)
    .eq("version", conv.version)
    .select("id");
  if (moved.error || !moved.data?.length) {
    await reopenLatestAssignment(conv.id);
    if (moved.error) throw moved.error;
    throw new ServiceError(STALE, 409);
  }
  const added = await db().from("conversation_assignments").insert({ conversation_id: conv.id, business_id: conv.businessId, member_id: toMemberId, assigned_by: actor.id });
  if (added.error) {
    await db().from("conversations").update({ assigned_member_id: conv.assignedMemberId }).eq("id", conv.id);
    await reopenLatestAssignment(conv.id);
    throw added.error;
  }
  await logEvent({ conversationId: conv.id, businessId: conv.businessId, type: "claimed", actorType: "member", actorMemberId: actor.id, from: "human", to: "human", payload: { reassigned_from: conv.assignedMemberId, reassigned_to: toMemberId } });
  return (await getConversation(conv.businessId, conv.id))!;
}

/** Deshace el cierre de la última asignación (compensación si falla un paso de la reasignación). */
async function reopenLatestAssignment(conversationId: string) {
  const { data } = await db().from("conversation_assignments").select("id").eq("conversation_id", conversationId).eq("release_reason", "reassigned").order("assigned_at", { ascending: false }).limit(1).maybeSingle();
  if (data) await db().from("conversation_assignments").update({ released_at: null, release_reason: null }).eq("id", data.id);
}

export interface AgentMessageResult {
  messageId: string;
  duplicate: boolean;
}

/**
 * T-09.5 · Mensaje del operador. Solo el asignado, con la conversación en `human` y la ventana de 24 h abierta.
 * `clientRequestId` (uuid del navegador) hace idempotente el doble clic y el reintento.
 */
export async function sendAgentMessage(actor: Member, conversationId: string, body: string, clientRequestId: string, channel: ChannelSender = whatsappChannel): Promise<AgentMessageResult> {
  const text = body.trim();
  if (!text) throw new ServiceError("Escribe un mensaje");
  if (text.length > 4096) throw new ServiceError("El mensaje admite hasta 4096 caracteres");
  if (!/^[0-9a-f-]{36}$/i.test(clientRequestId)) throw new ServiceError("Identificador de envío inválido");
  if (!actor.id) throw new ServiceError("Entra con un usuario del equipo para escribir", 403);

  const conv = await load(actor, conversationId);
  if (conv.status !== "human" || conv.assignedMemberId !== actor.id) throw new ServiceError("Tienes que tomar la conversación para responder", 409);

  const env = await replyEnv(conv);
  if (!env.lastInboundAt || Date.now() - env.lastInboundAt.getTime() > WINDOW_MS) {
    throw new ServiceError("Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite enviar una plantilla de reapertura", 409);
  }

  // Compuerta atómica: solo se envía si SIGUE siendo el asignado y la conversación sigue en `human`.
  const gate = await db()
    .from("conversations")
    .update({ last_message_at: new Date().toISOString(), unread_count: 0 })
    .eq("id", conv.id)
    .eq("business_id", conv.businessId)
    .eq("status", "human")
    .eq("assigned_member_id", actor.id)
    .select("id, first_response_at");
  if (gate.error) throw gate.error;
  if (!gate.data?.length) throw new ServiceError("La conversación cambió: ya no está asignada a ti", 409);

  const ref = await appendOutbound(conv, { senderType: "agent", senderMemberId: actor.id, clientRequestId, body: text });
  if (ref.duplicate && ref.existing && ref.existing.status !== "queued") return { messageId: ref.id, duplicate: true };

  try {
    const sent = await channel.sendText({ to: env.contact.externalId, lastInboundAt: env.lastInboundAt }, ref.existing?.body ?? text);
    await markOutboundSent(ref.id, sent.externalId);
    if (!gate.data[0].first_response_at) await db().from("conversations").update({ first_response_at: new Date().toISOString() }).eq("id", conv.id);
    return { messageId: ref.id, duplicate: ref.duplicate };
  } catch (error) {
    await markOutboundFailed(ref.id, error);
    await logEvent({ conversationId: conv.id, businessId: conv.businessId, type: "send_failed", actorType: "member", actorMemberId: actor.id, payload: { reason: error instanceof ChannelSendError ? error.reason ?? "rejected" : "network" } });
    throw new ServiceError(error instanceof ChannelSendError && error.permanent ? `WhatsApp rechazó el mensaje: ${error.message}` : "No se pudo enviar el mensaje. Intenta de nuevo", 409);
  }
}

/**
 * Plantilla de reapertura (D-08): única forma de escribir a un cliente cuando pasaron más de 24 h. Solo existe si
 * `WHATSAPP_REOPEN_TEMPLATE` está configurada (plantilla aprobada en WhatsApp Manager). El cliente debe responder
 * para abrir de nuevo la ventana; recién entonces el operador puede escribir libremente.
 */
export async function sendReopenTemplate(actor: Member, conversationId: string, clientRequestId: string): Promise<AgentMessageResult> {
  const template = reopenTemplateName();
  if (!template) throw new ServiceError("La plantilla de reapertura no está configurada", 409);
  if (!actor.id) throw new ServiceError("Entra con un usuario del equipo para escribir", 403);
  if (!/^[0-9a-f-]{36}$/i.test(clientRequestId)) throw new ServiceError("Identificador de envío inválido");

  const conv = await load(actor, conversationId);
  if (conv.status !== "human" || conv.assignedMemberId !== actor.id) throw new ServiceError("Tienes que tomar la conversación para responder", 409);
  const env = await replyEnv(conv);
  const { data: biz } = await db().from("businesses").select("name").eq("id", conv.businessId).single();
  const name = env.contact.displayName?.trim() || "hola";

  const ref = await appendOutbound(conv, { senderType: "agent", senderMemberId: actor.id, clientRequestId, body: `[Plantilla de reapertura] Hola ${name}, te escribimos de ${biz?.name ?? "el negocio"} por tu consulta.` });
  if (ref.duplicate && ref.existing && ref.existing.status !== "queued") return { messageId: ref.id, duplicate: true };
  try {
    const sent = await sendTemplate({ to: env.contact.externalId, template, bodyParams: retomarConversacionParams({ nombre: name, negocio: biz?.name ?? "" }) });
    await markOutboundSent(ref.id, sent.messageId);
    return { messageId: ref.id, duplicate: ref.duplicate };
  } catch (error) {
    await markOutboundFailed(ref.id, error);
    throw new ServiceError("No se pudo enviar la plantilla. Intenta de nuevo", 409);
  }
}
