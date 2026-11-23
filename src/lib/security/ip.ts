import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";

/**
 * IP del cliente tal como la informa la plataforma (Vercel antepone la IP real en x-forwarded-for).
 * Devuelve null fuera de una petición (jobs, pruebas) o si no hay cabecera.
 */
export async function getClientIp(): Promise<string | null> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || h.get("x-real-ip")?.trim() || null;
  } catch {
    return null;
  }
}

/** Hash con sal (AUDIT_IP_SALT): la auditoría nunca guarda la IP en claro (07 §19.11). */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

/** Hash de la IP de la petición actual para `audit_log.ip_hash`; null si no hay IP o falta AUDIT_IP_SALT. */
export async function auditIpHash(): Promise<string | null> {
  const salt = process.env.AUDIT_IP_SALT;
  if (!salt) return null;
  const ip = await getClientIp();
  return ip ? hashIp(ip, salt) : null;
}
