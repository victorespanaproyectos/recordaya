import { timingSafeEqual } from "node:crypto";

/**
 * Protege endpoints internos con "Authorization: Bearer <ADMIN_API_KEY>".
 * Es provisorio: cuando haya login de usuarios, se reemplaza por la sesión.
 */
export function isAuthorizedAdmin(request: Request): boolean {
  const expected = process.env.ADMIN_API_KEY;
  const header = request.headers.get("authorization");
  if (!expected || !header?.startsWith("Bearer ")) return false;

  const a = Buffer.from(header.slice("Bearer ".length));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
