import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type ConversationStatus = "bot" | "pending_human" | "human" | "resolved" | "closed";

export interface EventInput {
  conversationId: string;
  businessId: string;
  type: string;
  actorType?: "customer" | "bot" | "member" | "system";
  actorMemberId?: string | null;
  from?: ConversationStatus | null;
  to?: ConversationStatus | null;
  payload?: Record<string, unknown>;
}

/** Auditoría de la conversación (`conversation_events`). Un fallo al registrar nunca debe romper el mensaje. */
export async function logEvent(e: EventInput): Promise<void> {
  const { error } = await getSupabaseAdmin().from("conversation_events").insert({
    conversation_id: e.conversationId,
    business_id: e.businessId,
    type: e.type,
    actor_type: e.actorType ?? "system",
    actor_member_id: e.actorMemberId ?? null,
    from_status: e.from ?? null,
    to_status: e.to ?? null,
    payload: e.payload ?? {},
  });
  if (error) console.error("[conversation_events]", error.message);
}
