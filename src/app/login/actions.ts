"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLegacyLoginEnabled } from "@/lib/auth/legacy";
import { activateInvitedMembers } from "@/lib/auth/members";
import { createSupabaseServerClient, isSupabaseAuthConfigured } from "@/lib/auth/supabase-server";
import {
  createSessionToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
} from "@/lib/panel/session-token";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface LoginState {
  error?: string;
}

/** Evita redirecciones abiertas: solo rutas internas del panel. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/panel") && !next.startsWith("//") ? next : "/panel";
}

const BAD_CREDENTIALS = "Email o contraseña incorrectos.";

/**
 * Con email: inicia sesión con Supabase Auth (usuarios del equipo).
 * Sin email: contraseña compartida del panel (modo demo), mientras PANEL_LEGACY_LOGIN lo permita.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  // Pequeña demora fija: encarece probar contraseñas por fuerza bruta.
  const delay = new Promise((r) => setTimeout(r, 400));

  if (email) {
    if (!isSupabaseAuthConfigured()) return { error: "El acceso con usuarios no está configurado." };
    await delay;
    return signInWithEmail(email, password, formData);
  }

  if (!isLegacyLoginEnabled()) {
    await delay;
    return { error: "Ingresa tu email y tu contraseña." };
  }
  return signInLegacy(password, formData, delay);
}

async function signInWithEmail(email: string, password: string, formData: FormData): Promise<LoginState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: BAD_CREDENTIALS };

  // Primer login tras una invitación: enlaza el usuario y activa la membresía.
  await activateInvitedMembers(data.user);

  // Un usuario válido sin membresía activa no tiene a dónde entrar: se avisa aquí y no se deja sesión abierta.
  const { count, error: memberError } = await getSupabaseAdmin()
    .from("business_members")
    .select("id", { count: "exact", head: true })
    .eq("user_id", data.user.id)
    .eq("status", "active");
  if (memberError) {
    await supabase.auth.signOut();
    return { error: "Algo salió mal. Intenta de nuevo en unos segundos." };
  }
  if (!count) {
    await supabase.auth.signOut();
    return { error: "Tu usuario todavía no tiene acceso a ningún negocio." };
  }

  redirect(safeNext(formData.get("next")));
}

async function signInLegacy(password: string, formData: FormData, delay: Promise<unknown>): Promise<LoginState> {
  const expected = process.env.PANEL_PASSWORD;
  if (!expected) return { error: "El panel no está configurado (falta PANEL_PASSWORD)." };

  await delay;
  if (!safeEqual(password, expected)) return { error: "Contraseña incorrecta." };

  (await cookies()).set(SESSION_COOKIE, await createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  redirect(safeNext(formData.get("next")));
}

/** Cierra ambas sesiones: la de Supabase Auth y la legacy. */
export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  if (isSupabaseAuthConfigured()) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
