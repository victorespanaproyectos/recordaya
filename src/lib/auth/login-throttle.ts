import "server-only";
import { log } from "@/lib/logger";
import { getClientIp, hashIp } from "@/lib/security/ip";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Límite de intentos fallidos del login legacy (07 §19.2): 10 por IP en 15 min.
 * Solo se aplica a la contraseña compartida; el login por email lo limita Supabase Auth.
 * Si la tabla no responde se deja pasar (y se avisa en el log): bloquear a todos por una falla del contador sería peor.
 */
export const LOGIN_MAX_ATTEMPTS = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const db = () => getSupabaseAdmin();

/** Identidad del intentador: IP con hash. Sin IP (no debería pasar en Vercel) no hay límite por IP. */
export async function loginThrottleKey(): Promise<string | null> {
  const ip = await getClientIp();
  return ip ? hashIp(ip, process.env.AUDIT_IP_SALT ?? "recordaya-login") : null;
}

export async function isLoginBlocked(key: string | null, now: Date = new Date()): Promise<boolean> {
  if (!key) return false;
  const { count, error } = await db()
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", key)
    .gte("attempted_at", new Date(now.getTime() - LOGIN_WINDOW_MS).toISOString());
  if (error) {
    log.warn("login", "no se pudo consultar el límite de intentos", { error: error.message });
    return false;
  }
  return (count ?? 0) >= LOGIN_MAX_ATTEMPTS;
}

export async function recordFailedLogin(key: string | null): Promise<void> {
  if (!key) return;
  const { error } = await db().from("login_attempts").insert({ ip_hash: key });
  if (error) log.warn("login", "no se pudo registrar el intento fallido", { error: error.message });
}

export async function clearFailedLogins(key: string | null): Promise<void> {
  if (!key) return;
  const { error } = await db().from("login_attempts").delete().eq("ip_hash", key);
  if (error) log.warn("login", "no se pudo limpiar los intentos", { error: error.message });
}
