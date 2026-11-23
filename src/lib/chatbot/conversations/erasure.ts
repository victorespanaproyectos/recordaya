import "server-only";
import { ServiceError } from "@/lib/appointments/service";
import { can } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { log } from "@/lib/logger";
import { auditIpHash } from "@/lib/security/ip";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface ErasureCounts {
  conversations: number;
  unanswered_questions: number;
  inbound_messages: number;
  webhook_events: number;
}

/**
 * «Borrar datos de este contacto» (07 §19.12, T-12.6). Solo owner. El contacto debe ser del negocio de la sesión
 * (un id de otro negocio responde 404). El borrado es una sola transacción en la base (`delete_contact_data`).
 * La auditoría guarda el id y los conteos, nunca el teléfono ni el contenido.
 */
export async function eraseContactData(member: Member, conversationId: string): Promise<ErasureCounts> {
  if (!can(member.role, "contact.erase")) throw new ServiceError("Solo el propietario puede borrar los datos de un contacto", 403);

  const db = getSupabaseAdmin();
  const { data: conversation, error } = await db
    .from("conversations")
    .select("contact_id")
    .eq("id", conversationId)
    .eq("business_id", member.businessId)
    .maybeSingle();
  if (error) throw error;
  if (!conversation) throw new ServiceError("Conversación no encontrada", 404);

  const { data, error: rpcError } = await db.rpc("delete_contact_data", {
    p_business_id: member.businessId,
    p_contact_id: conversation.contact_id,
  });
  if (rpcError) throw rpcError;
  if (!data) throw new ServiceError("Contacto no encontrado", 404);
  const counts = data as ErasureCounts;

  const { error: auditError } = await db.from("audit_log").insert({
    business_id: member.businessId,
    actor_member_id: member.id,
    action: "contact.erased",
    target_type: "contact",
    target_id: conversation.contact_id,
    diff: counts,
    ip_hash: await auditIpHash(),
  });
  if (auditError) log.error("erasure", "el borrado se hizo pero no se pudo auditar", { businessId: member.businessId, error: auditError.message });
  return counts;
}
