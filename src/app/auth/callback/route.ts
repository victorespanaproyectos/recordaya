import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

const SET_PASSWORD_PATH = "/auth/definir-contrasena";
/** Tipos de enlace tras los cuales el usuario aún no tiene contraseña propia que conozca. */
const NEEDS_PASSWORD: EmailOtpType[] = ["invite", "recovery"];
const OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

/** Evita redirecciones abiertas: solo rutas internas del panel. */
function safeNext(value: string | null): string {
  return value && value.startsWith("/panel") && !value.startsWith("//") ? value : "/panel";
}

/**
 * GET /auth/callback
 * Destino de los enlaces de Supabase Auth (invitación, recuperación, enlace mágico). Acepta:
 *  - ?code=…                  (flujo PKCE) → exchangeCodeForSession
 *  - ?token_hash=…&type=…     (plantillas de email con TokenHash) → verifyOtp
 * Cualquier fallo redirige a /login?error=… sin revelar el detalle.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const rawType = searchParams.get("type");
  const type = OTP_TYPES.find((t) => t === rawType);

  const fail = () => NextResponse.redirect(new URL("/login?error=enlace", origin));

  try {
    const supabase = await createSupabaseServerClient();
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return fail();
    } else if (tokenHash && type) {
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) return fail();
    } else {
      return fail();
    }
  } catch (error) {
    console.error("[auth/callback]", error instanceof Error ? error.message : "error");
    return fail();
  }

  const destination =
    (type && NEEDS_PASSWORD.includes(type)) || searchParams.get("set_password") === "1"
      ? SET_PASSWORD_PATH
      : safeNext(searchParams.get("next"));
  return NextResponse.redirect(new URL(destination, origin));
}
