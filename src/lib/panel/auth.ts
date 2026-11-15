import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isValidSessionToken, SESSION_COOKIE } from "./session-token";

/** ¿La petición actual tiene una sesión válida del panel? */
export async function hasPanelSession(): Promise<boolean> {
  // Todo lo que sigue (sesión, Date.now, datos) es por petición: no se prerenderiza.
  await connection();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

/**
 * Exige sesión. Se llama en cada página y en cada Server Action del panel:
 * las acciones son endpoints POST alcanzables directamente, no basta con el proxy.
 */
export async function requirePanelSession(): Promise<void> {
  if (!(await hasPanelSession())) redirect("/login");
}
