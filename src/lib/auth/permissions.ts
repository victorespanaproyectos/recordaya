/**
 * Matriz de permisos del panel (06 §3.2). Función pura: sin dependencias, fácil de probar.
 * Toda acción de servidor debe comprobar `can(...)` o `hasMinRole(...)`; ocultar un botón no basta.
 */

export type Role = "owner" | "admin" | "operator";

const RANK: Record<Role, number> = { operator: 1, admin: 2, owner: 3 };

/** ¿El rol alcanza al menos el nivel `min`? */
export function hasMinRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** Rol mínimo requerido por cada permiso. */
const REQUIRED_ROLE = {
  "agenda.view": "operator",
  "inbox.view": "operator",
  "conversation.handle_own": "operator", // tomar, responder, liberar, devolver, resolver (las propias)
  "conversation.reassign_or_close_any": "admin",
  "knowledge.view": "operator", // el operador solo lee
  "knowledge.write": "admin",
  "unanswered.view": "operator",
  "unanswered.resolve": "admin",
  "chatbot.configure": "admin", // mensajes, horario, tono
  "chatbot.model_and_budget": "owner",
  "metrics.view": "operator", // el operador ve métricas sin costos
  "usage_costs.view": "admin",
  "members.manage": "admin", // el admin no gestiona owners: ver canManageRole
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof REQUIRED_ROLE;

export function can(role: Role, permission: Permission): boolean {
  return hasMinRole(role, REQUIRED_ROLE[permission]);
}

/** Invitar o editar a un miembro con rol `target`: un admin no puede tocar owners. */
export function canManageRole(actor: Role, target: Role): boolean {
  if (!can(actor, "members.manage")) return false;
  return target !== "owner" || actor === "owner";
}
