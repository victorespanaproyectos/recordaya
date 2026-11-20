"use server";

import { refresh } from "next/cache";
import { ServiceError } from "@/lib/appointments/service";
import { inviteMember, setAvailability, updateMember, type MemberPatch } from "@/lib/auth/members";
import type { Role } from "@/lib/auth/permissions";
import { requireMember } from "@/lib/auth/session";
import type { ActionResult } from "../actions";

function toError(error: unknown, scope: string): ActionResult {
  if (error instanceof ServiceError) return { ok: false, error: error.message };
  console.error(`[panel/equipo/${scope}]`, error instanceof Error ? error.message : "error");
  return { ok: false, error: "Algo salió mal. Intenta de nuevo en unos segundos." };
}

const ROLES: readonly string[] = ["owner", "admin", "operator"];

/** Invita a una persona al equipo (admin; el rol `owner` solo lo puede dar un owner). */
export async function inviteMemberAction(input: { email: string; name: string; role: string }): Promise<ActionResult> {
  const member = await requireMember("admin");
  if (!ROLES.includes(input.role)) return { ok: false, error: "Rol inválido" };
  try {
    const invited = await inviteMember(member, { email: String(input.email ?? ""), name: String(input.name ?? ""), role: input.role as Role });
    refresh();
    return { ok: true, id: invited.id, message: `Invitación enviada a ${invited.email}` };
  } catch (error) {
    return toError(error, "invite");
  }
}

/** Cambia rol, máximo de conversaciones o estado (activar / desactivar). */
export async function updateMemberAction(id: string, patch: { role?: string; maxConcurrent?: number; status?: string }): Promise<ActionResult> {
  const member = await requireMember("admin");
  if (patch.role !== undefined && !ROLES.includes(patch.role)) return { ok: false, error: "Rol inválido" };
  if (patch.status !== undefined && patch.status !== "active" && patch.status !== "disabled") return { ok: false, error: "Estado inválido" };
  try {
    await updateMember(member, id, patch as MemberPatch);
    refresh();
    return { ok: true, message: "Cambios guardados" };
  } catch (error) {
    return toError(error, "update");
  }
}

/** Interruptor «Disponible» del propio miembro (cualquier rol). */
export async function setMyAvailabilityAction(available: boolean): Promise<ActionResult> {
  const member = await requireMember("operator");
  try {
    await setAvailability(member, available === true);
    return { ok: true, message: available ? "Estás disponible para recibir conversaciones" : "Ya no recibes conversaciones nuevas" };
  } catch (error) {
    return toError(error, "availability");
  }
}
