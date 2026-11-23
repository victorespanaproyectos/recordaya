import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { requireEnv } from "@/lib/env";

/**
 * Cliente de Supabase Auth con la sesión del usuario (cookies `sb-*`), usando la clave PUBLICABLE.
 * Es distinto de `getSupabaseAdmin()` (clave secreta, salta RLS): este solo sirve para identificar
 * al usuario; los datos se siguen leyendo con el cliente de administración, acotados por negocio.
 *
 * Crear uno nuevo por petición: nunca compartirlo entre peticiones.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, { ...options, httpOnly: true });
          } catch {
            // Render de un Server Component: no se pueden escribir cookies ahí. Es esperable;
            // la renovación de la sesión ocurre en el proxy, en Server Actions y en Route Handlers.
          }
        },
      },
    },
  );
}

export function isSupabaseAuthConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
