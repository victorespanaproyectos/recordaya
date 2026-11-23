import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isLegacyLoginEnabled } from "@/lib/auth/legacy";
import { isValidSessionToken, SESSION_COOKIE } from "@/lib/panel/session-token";

/**
 * Chequeo optimista de /panel: sin sesión válida redirige a /login. Acepta
 *  1) una sesión de Supabase Auth (cookies sb-*), y de paso renueva sus tokens (los Server Components no
 *     pueden escribir cookies, así que la renovación tiene que ocurrir aquí), o
 *  2) la cookie legacy `ry_panel`, mientras PANEL_LEGACY_LOGIN no sea "false".
 * La autorización real (membresía y rol) la hace cada página y Server Action con requireMember().
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (url && key) {
    try {
      const supabase = createServerClient(url, key, {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookiesToSet) => {
            for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
            response = NextResponse.next({ request });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, { ...options, httpOnly: true });
            }
          },
        },
      });
      // getClaims verifica la firma del JWT sin llamar a la red y renueva el token si venció.
      const { data } = await supabase.auth.getClaims();
      if (data?.claims) return response;
    } catch {
      // Sin sesión válida de Supabase: se prueba la legacy.
    }
  }

  if (isLegacyLoginEnabled() && (await isValidSessionToken(request.cookies.get(SESSION_COOKIE)?.value))) {
    return NextResponse.next({ request });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/panel/:path*"],
};
