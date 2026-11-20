import "server-only";
import { getCurrentMember, requireMember } from "@/lib/auth/session";

/** ¿La petición actual tiene acceso al panel (sesión de usuario o, si está activa, la legacy)? */
export async function hasPanelSession(): Promise<boolean> {
  return (await getCurrentMember()) !== null;
}

/**
 * Exige sesión. Se llama en cada página y en cada Server Action del panel:
 * las acciones son endpoints POST alcanzables directamente, no basta con el proxy.
 * Delega en `requireMember` (rol mínimo: operador).
 */
export async function requirePanelSession(): Promise<void> {
  await requireMember("operator");
}
