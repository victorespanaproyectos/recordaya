import "server-only";
import { auditIpHash } from "@/lib/security/ip";
import { ServiceError } from "@/lib/appointments/service";
import { canManageRole, type Role } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { getAppUrl } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Servicio de miembros del equipo (T-03.4). Lo usan las Server Actions de /panel/equipo (T-10.6).
 * Toda función recibe al `actor` (ya validado con `requireMember`) y trabaja solo dentro de su negocio.
 */

export type MemberStatus = "invited" | "active" | "disabled";

export interface TeamMember {
  id: string;
  businessId: string;
  userId: string | null;
  email: string;
  displayName: string;
  role: Role;
  status: MemberStatus;
  isAvailable: boolean;
  maxConcurrent: number;
}

interface MemberRow {
  id: string;
  business_id: string;
  user_id: string | null;
  email: string;
  display_name: string;
  role: Role;
  status: MemberStatus;
  is_available: boolean;
  max_concurrent: number;
}

const COLUMNS = "id, business_id, user_id, email, display_name, role, status, is_available, max_concurrent";
const ROLES: readonly Role[] = ["owner", "admin", "operator"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const db = () => getSupabaseAdmin();

function toMember(row: MemberRow): TeamMember {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    isAvailable: row.is_available,
    maxConcurrent: row.max_concurrent,
  };
}

function assertCanManage(actor: Member, target: Role) {
  if (!canManageRole(actor.role, target)) {
    throw new ServiceError("No tienes permiso para gestionar este rol", 403);
  }
}

async function audit(
  actor: Member,
  action: string,
  targetId: string,
  diff: Record<string, unknown>,
  businessId = actor.businessId,
) {
  const { error } = await db().from("audit_log").insert({
    business_id: businessId,
    actor_member_id: actor.id, // nulo en la sesión legacy (no hay miembro real)
    action,
    target_type: "member",
    target_id: targetId,
    diff,
    ip_hash: await auditIpHash(),
  });
  if (error) throw error;
}

async function loadMember(actor: Member, id: string): Promise<MemberRow> {
  const { data, error } = await db()
    .from("business_members")
    .select(COLUMNS)
    .eq("id", id)
    .eq("business_id", actor.businessId) // un miembro de otro negocio es "no existe"
    .maybeSingle<MemberRow>();
  if (error) throw error;
  if (!data) throw new ServiceError("El miembro no existe", 404);
  return data;
}

async function countActiveOwners(businessId: string): Promise<number> {
  const { count, error } = await db()
    .from("business_members")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("role", "owner")
    .eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}

export async function listMembers(actor: Member): Promise<TeamMember[]> {
  const { data, error } = await db()
    .from("business_members")
    .select(COLUMNS)
    .eq("business_id", actor.businessId)
    .order("created_at")
    .returns<MemberRow[]>();
  if (error) throw error;
  return (data ?? []).map(toMember);
}

export interface InviteInput {
  email: string;
  name: string;
  role: Role;
}

/**
 * Crea la fila `invited` y envía la invitación por email (Supabase Auth). Si el envío falla, deshace la fila.
 * Un admin no puede invitar owners.
 */
export async function inviteMember(actor: Member, input: InviteInput): Promise<TeamMember> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ServiceError("El email no es válido");
  if (name.length < 1 || name.length > 80) throw new ServiceError("El nombre debe tener entre 1 y 80 caracteres");
  if (!ROLES.includes(input.role)) throw new ServiceError("Rol inválido");
  assertCanManage(actor, input.role);

  const { data: row, error } = await db()
    .from("business_members")
    .insert({ business_id: actor.businessId, email, display_name: name, role: input.role, status: "invited" })
    .select(COLUMNS)
    .single<MemberRow>();
  if (error) {
    if (error.code === "23505") throw new ServiceError("Ya existe un miembro con ese email", 409);
    throw error;
  }

  const { error: inviteError } = await db().auth.admin.inviteUserByEmail(email, {
    redirectTo: `${getAppUrl()}/auth/confirmar`,
  });
  if (inviteError) {
    await db().from("business_members").delete().eq("id", row.id);
    const taken = /already|registered|exists/i.test(inviteError.message);
    throw new ServiceError(
      taken
        ? "Ese email ya tiene una cuenta; no se puede invitar por esta vía"
        : "No se pudo enviar la invitación. Intenta de nuevo en unos minutos",
      taken ? 409 : 400,
    );
  }

  await audit(actor, "member.invited", row.id, { email, role: input.role });
  return toMember(row);
}

/**
 * Enlaza `user_id` y activa las invitaciones pendientes de este email (primer login).
 * Solo se activa con email confirmado: aceptar el enlace de invitación lo confirma.
 * Devuelve cuántas membresías se activaron.
 */
export async function activateInvitedMembers(user: {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
}): Promise<number> {
  if (!user.email || !user.email_confirmed_at) return 0;
  const { data, error } = await db()
    .from("business_members")
    .update({ user_id: user.id, status: "active" })
    .eq("email", user.email.toLowerCase())
    .eq("status", "invited")
    .is("user_id", null)
    .select("id, business_id");
  if (error) throw error;
  for (const m of data ?? []) {
    const { error: auditError } = await db().from("audit_log").insert({
      business_id: m.business_id,
      actor_member_id: m.id,
      action: "member.activated",
      target_type: "member",
      target_id: m.id,
      ip_hash: await auditIpHash(),
    });
    if (auditError) throw auditError;
  }
  return data?.length ?? 0;
}

export interface MemberPatch {
  role?: Role;
  maxConcurrent?: number;
  /** Solo `active` (reactivar) o `disabled` (desactivar). */
  status?: "active" | "disabled";
}

/**
 * Libera las conversaciones `human` de un miembro (pasan a `pending_human`, T6 de 05 §16.2).
 * Lo usan desactivar y eliminar. Las acciones de conversación del operador llegan en T-09.3.
 */
export async function releaseMemberConversations(businessId: string, memberId: string): Promise<number> {
  const { data: convs, error } = await db()
    .from("conversations")
    .select("id")
    .eq("business_id", businessId)
    .eq("assigned_member_id", memberId)
    .eq("status", "human");
  if (error) throw error;

  let released = 0;
  for (const { id } of convs ?? []) {
    const { data: updated, error: updateError } = await db()
      .from("conversations")
      .update({ status: "pending_human", assigned_member_id: null, assigned_at: null })
      .eq("id", id)
      .eq("assigned_member_id", memberId)
      .eq("status", "human")
      .select("id, version");
    if (updateError) throw updateError;
    if (!updated?.length) continue; // otro proceso ya la movió

    await db().from("conversations").update({ version: updated[0].version + 1 }).eq("id", id);
    await db()
      .from("conversation_assignments")
      .update({ released_at: new Date().toISOString(), release_reason: "member_disabled" })
      .eq("conversation_id", id)
      .is("released_at", null);
    await db().from("conversation_events").insert({
      conversation_id: id,
      business_id: businessId,
      type: "released",
      actor_type: "system",
      from_status: "human",
      to_status: "pending_human",
      payload: { reason: "member_disabled", member_id: memberId },
    });
    released++;
  }
  return released;
}

/** Cambia rol, límite de conversaciones o estado. No degrada ni desactiva al último owner activo. */
export async function updateMember(actor: Member, memberId: string, patch: MemberPatch): Promise<TeamMember> {
  const target = await loadMember(actor, memberId);
  assertCanManage(actor, target.role);

  const update: Record<string, unknown> = {};
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw new ServiceError("Rol inválido");
    assertCanManage(actor, patch.role);
    if (patch.role !== target.role) update.role = patch.role;
  }
  if (patch.maxConcurrent !== undefined) {
    if (!Number.isInteger(patch.maxConcurrent) || patch.maxConcurrent < 1 || patch.maxConcurrent > 50) {
      throw new ServiceError("El máximo de conversaciones debe estar entre 1 y 50");
    }
    update.max_concurrent = patch.maxConcurrent;
  }
  let nextStatus: MemberStatus = target.status;
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "disabled") throw new ServiceError("Estado inválido");
    if (patch.status === "active" && target.status === "invited") {
      throw new ServiceError("La invitación todavía no fue aceptada");
    }
    if (patch.status === "active" && target.status === "disabled") {
      // Quien nunca llegó a activarse vuelve a "invitado".
      nextStatus = target.user_id ? "active" : "invited";
    } else if (patch.status === "disabled") {
      nextStatus = "disabled";
    }
    if (nextStatus !== target.status) update.status = nextStatus;
  }
  if (Object.keys(update).length === 0) return toMember(target);

  const losesOwnership =
    target.role === "owner" && target.status === "active" && (update.role !== undefined || nextStatus !== "active");
  if (losesOwnership && (await countActiveOwners(actor.businessId)) <= 1) {
    throw new ServiceError("Debe quedar al menos un owner activo en el negocio", 409);
  }

  const { data, error } = await db()
    .from("business_members")
    .update(update)
    .eq("id", memberId)
    .eq("business_id", actor.businessId)
    .select(COLUMNS)
    .single<MemberRow>();
  if (error) throw error;

  // Dos owners que se degradan a la vez pasarían ambos la comprobación: se verifica después y se deshace.
  if (losesOwnership && (await countActiveOwners(actor.businessId)) === 0) {
    await db()
      .from("business_members")
      .update({ role: target.role, status: target.status })
      .eq("id", memberId);
    throw new ServiceError("Debe quedar al menos un owner activo en el negocio", 409);
  }

  if (update.status === "disabled") await releaseMemberConversations(actor.businessId, memberId);

  const diff: Record<string, unknown> = {};
  if (update.role !== undefined) diff.role = { from: target.role, to: update.role };
  if (update.status !== undefined) diff.status = { from: target.status, to: update.status };
  if (update.max_concurrent !== undefined) diff.max_concurrent = { from: target.max_concurrent, to: update.max_concurrent };
  const action = update.role !== undefined ? "member.role_changed" : update.status !== undefined ? "member.status_changed" : "member.updated";
  await audit(actor, action, memberId, diff);
  return toMember(data);
}

/** Elimina a un miembro (libera antes sus conversaciones). El último owner activo no se puede eliminar. */
export async function removeMember(actor: Member, memberId: string): Promise<void> {
  const target = await loadMember(actor, memberId);
  assertCanManage(actor, target.role);
  if (target.role === "owner" && target.status === "active" && (await countActiveOwners(actor.businessId)) <= 1) {
    throw new ServiceError("Debe quedar al menos un owner activo en el negocio", 409);
  }

  await releaseMemberConversations(actor.businessId, memberId);
  const { error } = await db().from("business_members").delete().eq("id", memberId).eq("business_id", actor.businessId);
  if (error) throw error;
  await audit(actor, "member.removed", memberId, { email: target.email, role: target.role });
}

/** Disponibilidad propia para recibir conversaciones. Solo un miembro real y activo. */
export async function setAvailability(actor: Member, available: boolean): Promise<void> {
  if (!actor.id) throw new ServiceError("La sesión de demostración no tiene disponibilidad propia", 400);
  const { data, error } = await db()
    .from("business_members")
    .update({ is_available: available })
    .eq("id", actor.id)
    .eq("business_id", actor.businessId)
    .eq("status", "active")
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new ServiceError("El miembro no existe", 404);
}
