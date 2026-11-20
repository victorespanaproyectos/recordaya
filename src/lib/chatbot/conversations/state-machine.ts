import "server-only";
import { ServiceError } from "@/lib/appointments/service";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { logEvent, type ConversationStatus } from "./events";
import { CONVERSATION_COLUMNS, toConversation, type Conversation } from "./service";

/**
 * Máquina de estados de la conversación (05 §16.2). Toda transición es un
 * `update … where id = $1 and business_id = $2 and status = $from and version = $v returning …` y exige UNA fila:
 * si otro proceso cambió la conversación en el medio, falla con 409 y el panel pide recargar.
 */

export type TransitionName =
  | "request_handoff" //   T2/T3  bot → pending_human (el cliente acepta, o un miembro deriva)
  | "claim" //             T4     bot | pending_human | resolved → human
  | "decline_handoff" //   T5     pending_human → bot (cliente o miembro)
  | "release" //           T6     human → pending_human
  | "return_to_bot" //     T7     human → bot
  | "resolve" //           T8     human → resolved
  | "auto_resolve" //      T9     bot → resolved (mantenimiento)
  | "reopen" //            T10    resolved → bot (mensaje nuevo)
  | "close" //             T11/12 cualquiera ≠ closed → closed
  | "member_disabled"; //  human → pending_human (operador desactivado)

interface Transition {
  from: readonly ConversationStatus[];
  to: ConversationStatus;
  /** Motivo con que se cierra la asignación abierta (si la hay). */
  releases?: "released" | "returned_to_bot" | "resolved" | "closed" | "member_disabled";
  event: string;
}

const NOT_CLOSED: readonly ConversationStatus[] = ["bot", "pending_human", "human", "resolved"];

export const TRANSITIONS: Record<TransitionName, Transition> = {
  request_handoff: { from: ["bot"], to: "pending_human", event: "handoff_accepted" },
  claim: { from: ["bot", "pending_human", "resolved"], to: "human", event: "claimed" },
  decline_handoff: { from: ["pending_human"], to: "bot", event: "returned_to_bot" },
  release: { from: ["human"], to: "pending_human", releases: "released", event: "released" },
  return_to_bot: { from: ["human"], to: "bot", releases: "returned_to_bot", event: "returned_to_bot" },
  resolve: { from: ["human"], to: "resolved", releases: "resolved", event: "resolved" },
  auto_resolve: { from: ["bot"], to: "resolved", event: "resolved" },
  reopen: { from: ["resolved"], to: "bot", event: "reopened" },
  close: { from: NOT_CLOSED, to: "closed", releases: "closed", event: "closed" },
  member_disabled: { from: ["human"], to: "pending_human", releases: "member_disabled", event: "released" },
};

export interface Actor {
  type: "customer" | "member" | "system" | "bot";
  memberId?: string | null;
}

export interface TransitionOptions {
  /** Versión leída por quien decide; por defecto la de `conversation`. */
  expectedVersion?: number;
  /** Quién queda asignado (solo `claim`). */
  assignTo?: string;
  reason?: string;
  payload?: Record<string, unknown>;
}

const db = () => getSupabaseAdmin();
export const STALE = "La conversación cambió, recarga";

/** ¿Se permite esta transición desde este estado? (para la UI y las pruebas) */
export function canTransition(name: TransitionName, from: ConversationStatus): boolean {
  return TRANSITIONS[name].from.includes(from);
}

export async function transition(name: TransitionName, conversation: Conversation, actor: Actor, options: TransitionOptions = {}): Promise<Conversation> {
  const t = TRANSITIONS[name];
  if (!t.from.includes(conversation.status)) {
    throw new ServiceError(`No se puede hacer eso con una conversación en estado «${conversation.status}»`, 409);
  }
  const version = options.expectedVersion ?? conversation.version;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: t.to, version: version + 1 };

  if (name === "claim") {
    // Toma atómica: solo una llamada concurrente gana (select … for update dentro de la función SQL).
    if (!options.assignTo) throw new ServiceError("Falta el miembro que toma la conversación", 400);
    if (options.expectedVersion !== undefined && options.expectedVersion !== conversation.version) throw new ServiceError(STALE, 409);
    const { data, error } = await db().rpc("claim_conversation", {
      p_conversation_id: conversation.id,
      p_business_id: conversation.businessId,
      p_member_id: options.assignTo,
      p_assigned_by: actor.memberId ?? options.assignTo,
    });
    if (error) throw error;
    if (data !== true) throw new ServiceError("Otro operador ya tomó esta conversación", 409);
    return reload(conversation);
  }

  if (t.releases || name === "decline_handoff") Object.assign(patch, { assigned_member_id: null, assigned_at: null });
  if (name === "return_to_bot" || name === "decline_handoff") Object.assign(patch, { consecutive_failures: 0, handoff_offered_at: null });
  if (name === "request_handoff") patch.handoff_requested_at = now;
  if (name === "resolve" || name === "auto_resolve") Object.assign(patch, { resolved_at: now, resolved_by: name === "resolve" ? "human" : "bot" });
  if (name === "close") patch.closed_at = now;
  if (name === "reopen") Object.assign(patch, { resolved_at: null, resolved_by: null });
  if (name === "request_handoff" && actor.type === "member") patch.handoff_reason = "operator_initiated";

  const { data, error } = await db()
    .from("conversations")
    .update(patch)
    .eq("id", conversation.id)
    .eq("business_id", conversation.businessId)
    .eq("status", conversation.status)
    .eq("version", version)
    .select(CONVERSATION_COLUMNS);
  if (error) throw error;
  if (!data?.length) throw new ServiceError(STALE, 409);

  if (t.releases) {
    const { error: assignmentError } = await db()
      .from("conversation_assignments")
      .update({ released_at: now, release_reason: t.releases })
      .eq("conversation_id", conversation.id)
      .is("released_at", null);
    if (assignmentError) throw assignmentError;
  }
  await logEvent({
    conversationId: conversation.id,
    businessId: conversation.businessId,
    type: t.event,
    actorType: actor.type,
    actorMemberId: actor.memberId ?? null,
    from: conversation.status,
    to: t.to,
    payload: { ...(options.reason && { reason: options.reason }), ...options.payload },
  });
  return toConversation(data[0] as never);
}

async function reload(conversation: Conversation): Promise<Conversation> {
  const { data, error } = await db().from("conversations").select(CONVERSATION_COLUMNS).eq("id", conversation.id).eq("business_id", conversation.businessId).single();
  if (error) throw error;
  return toConversation(data as never);
}
