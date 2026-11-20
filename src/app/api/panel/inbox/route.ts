import { getCurrentMember } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * GET /api/panel/inbox
 * Contadores para la navegación (se consulta cada pocos segundos mientras el panel está abierto):
 *  - pending: conversaciones esperando a una persona (en cola, sin asignar);
 *  - mine / mineUnread: las que tengo asignadas y cuántos mensajes sin leer tienen.
 * Además marca `last_seen_at` del miembro: es la señal de presencia que usa el mantenimiento para su disponibilidad.
 */
export async function GET() {
  const member = await getCurrentMember();
  if (!member) return Response.json({ error: "No autorizado" }, { status: 401, headers: { "Cache-Control": "no-store" } });

  const db = getSupabaseAdmin();
  const now = new Date().toISOString();
  const [pending, mine, available] = await Promise.all([
    db.from("conversations").select("id", { count: "exact", head: true }).eq("business_id", member.businessId).eq("status", "pending_human"),
    member.id
      ? db.from("conversations").select("unread_count").eq("business_id", member.businessId).eq("status", "human").eq("assigned_member_id", member.id)
      : Promise.resolve({ data: [] as { unread_count: number }[], error: null }),
    member.id
      ? db.from("business_members").update({ last_seen_at: now }).eq("id", member.id).eq("business_id", member.businessId).select("is_available").maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (pending.error || mine.error || available.error) return Response.json({ error: "Error temporal" }, { status: 500, headers: { "Cache-Control": "no-store" } });

  const rows = mine.data ?? [];
  return Response.json(
    {
      pending: pending.count ?? 0,
      mine: rows.length,
      mineUnread: rows.reduce((sum, r) => sum + (r.unread_count ?? 0), 0),
      available: available.data?.is_available ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
