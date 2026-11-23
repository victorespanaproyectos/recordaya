import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

const NEEDS_PASSWORD = ["invite", "recovery"];

/**
 * POST /auth/session
 * Cierra el flujo de los enlaces por defecto de Supabase (invitación, recuperación), que entregan los
 * tokens en el fragmento `#…` de la URL: el servidor no lo ve, así que la página /auth/confirmar los
 * reenvía aquí. Se verifican con Supabase antes de crear la sesión (cookies del servidor).
 *
 * Body: { access_token, refresh_token, type? } → { redirect }
 */
export async function POST(request: NextRequest) {
  // Solo desde nuestra propia página.
  if (request.headers.get("origin") !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Origen no permitido" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    type?: unknown;
  } | null;
  const accessToken = body?.access_token;
  const refreshToken = body?.refresh_token;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || !accessToken || !refreshToken) {
    return NextResponse.json({ error: "Faltan los tokens" }, { status: 400 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    // getUser(jwt) valida el token contra Supabase: no basta con decodificarlo.
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data.user) return NextResponse.json({ error: "Enlace inválido o vencido" }, { status: 401 });

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (sessionError) return NextResponse.json({ error: "Enlace inválido o vencido" }, { status: 401 });
  } catch (error) {
    console.error("[auth/session]", error instanceof Error ? error.message : "error");
    return NextResponse.json({ error: "Error inesperado" }, { status: 500 });
  }

  const type = typeof body?.type === "string" ? body.type : "";
  return NextResponse.json({ redirect: NEEDS_PASSWORD.includes(type) ? "/auth/definir-contrasena" : "/panel" });
}
