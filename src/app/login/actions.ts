"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSessionToken,
  safeEqual,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
} from "@/lib/panel/session-token";

export interface LoginState {
  error?: string;
}

/** Evita redirecciones abiertas: solo rutas internas del panel. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = typeof value === "string" ? value : "";
  return next.startsWith("/panel") && !next.startsWith("//") ? next : "/panel";
}

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const expected = process.env.PANEL_PASSWORD;
  if (!expected) return { error: "El panel no está configurado (falta PANEL_PASSWORD)." };

  const password = String(formData.get("password") ?? "");
  // Pequeña demora fija: encarece probar contraseñas por fuerza bruta.
  await new Promise((r) => setTimeout(r, 400));
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

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
