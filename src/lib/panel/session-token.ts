/**
 * Token de sesión del panel: "<expiración ms>.<firma HMAC-SHA256 base64url>".
 * Usa Web Crypto para funcionar igual en el proxy y en el servidor.
 */

export const SESSION_COOKIE = "ry_panel";
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

function secret(): string {
  const value = process.env.PANEL_SESSION_SECRET || process.env.ADMIN_API_KEY;
  if (!value) throw new Error("Falta PANEL_SESSION_SECRET (o ADMIN_API_KEY) para firmar sesiones");
  return value;
}

const encoder = new TextEncoder();

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Comparación en tiempo constante de dos strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(): Promise<string> {
  const exp = String(Date.now() + SESSION_MAX_AGE_S * 1000);
  return `${exp}.${await sign(exp)}`;
}

export async function isValidSessionToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  try {
    return safeEqual(sig, await sign(exp));
  } catch {
    return false;
  }
}

export { safeEqual };
