import "server-only";
import { cookies } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { connection } from "next/server";
import { isSupabaseAuthConfigured, createSupabaseServerClient } from "@/lib/auth/supabase-server";
import { isLegacyLoginEnabled } from "@/lib/auth/legacy";
import { activateInvitedMembers } from "@/lib/auth/members";
import { hasMinRole, type Role } from "@/lib/auth/permissions";
import { isValidSessionToken, SESSION_COOKIE } from "@/lib/panel/session-token";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface Member {
  /** `business_members.id`; nulo en la sesión legacy (no hay miembro real). */
  id: string | null;
  userId: string | null;
  businessId: string;
  role: Role;
  displayName: string;
  legacy: boolean;
}

/** Cookie con el negocio elegido por usuarios que pertenecen a más de uno (se valida siempre). */
export const BUSINESS_COOKIE = "ry_business";

type Identity =
  | { kind: "none" } // sin sesión
  | { kind: "no_membership" } // sesión de Supabase válida pero sin acceso a ningún negocio
  | { kind: "member"; member: Member };

interface MemberRow {
  id: string;
  user_id: string;
  business_id: string;
  role: Role;
  display_name: string;
}

async function memberFromSupabaseSession(): Promise<Identity | null> {
  if (!isSupabaseAuthConfigured()) return null;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser(); // valida el token con Supabase
  const user = data.user;
  if (!user) return null;

  const loadRows = async () => {
    const { data: found, error } = await getSupabaseAdmin()
      .from("business_members")
      .select("id, user_id, business_id, role, display_name")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at")
      .returns<MemberRow[]>();
    if (error) throw error;
    return found ?? [];
  };
  let rows = await loadRows();
  if (rows.length === 0 && (await activateInvitedMembers(user)) > 0) rows = await loadRows(); // primer login tras invitación
  if (rows.length === 0) return { kind: "no_membership" };

  // Varios negocios: se respeta la cookie solo si corresponde a una membresía real.
  const chosen = (await cookies()).get(BUSINESS_COOKIE)?.value;
  const row = rows.find((r) => r.business_id === chosen) ?? rows[0];
  return {
    kind: "member",
    member: {
      id: row.id,
      userId: row.user_id,
      businessId: row.business_id,
      role: row.role,
      displayName: row.display_name,
      legacy: false,
    },
  };
}

/** Sesión legacy → miembro virtual `owner` del negocio por defecto (el más antiguo). */
async function memberFromLegacySession(): Promise<Identity | null> {
  if (!isLegacyLoginEnabled()) return null;
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await isValidSessionToken(token))) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("businesses")
    .select("id")
    .order("created_at")
    .limit(1);
  if (error) throw error;
  const businessId = data?.[0]?.id;
  if (!businessId) return { kind: "no_membership" };

  return {
    kind: "member",
    member: { id: null, userId: null, businessId, role: "owner", displayName: "Demo", legacy: true },
  };
}

async function resolveIdentity(): Promise<Identity> {
  // Todo lo que sigue (cookies, Date.now, datos) es por petición: no se prerenderiza.
  await connection();
  return (await memberFromSupabaseSession()) ?? (await memberFromLegacySession()) ?? { kind: "none" };
}

/** Miembro de la petición actual, o null si no hay sesión o no tiene acceso a ningún negocio. */
export async function getCurrentMember(): Promise<Member | null> {
  const identity = await resolveIdentity();
  return identity.kind === "member" ? identity.member : null;
}

/**
 * Exige un miembro con rol mínimo `min`.
 * Sin sesión → /login. Sesión sin membresía, o rol insuficiente → 403 (`forbidden()`).
 */
export async function requireMember(min: Role = "operator"): Promise<Member> {
  const identity = await resolveIdentity();
  if (identity.kind === "none") redirect("/login");
  if (identity.kind === "no_membership") forbidden();
  if (!hasMinRole(identity.member.role, min)) forbidden();
  return identity.member;
}
