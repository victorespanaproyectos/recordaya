"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/auth/supabase-server";

export interface SetPasswordState {
  error?: string;
}

const MIN_PASSWORD_LENGTH = 8;

/** Define la contraseña del usuario que llegó por invitación o recuperación (ya tiene sesión). */
export async function setPasswordAction(_prev: SetPasswordState, formData: FormData): Promise<SetPasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` };
  }
  if (password !== confirm) return { error: "Las contraseñas no coinciden." };

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login?error=enlace");

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: "No se pudo guardar la contraseña. Pide una invitación nueva." };

  redirect("/panel");
}
