"use client";

import { LoaderCircle } from "lucide-react";
import { useActionState } from "react";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { setPasswordAction, type SetPasswordState } from "./actions";

export function SetPasswordForm() {
  const [state, action, pending] = useActionState<SetPasswordState, FormData>(setPasswordAction, {});

  return (
    <form action={action} className="space-y-5">
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Nueva contraseña
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoFocus
          autoComplete="new-password"
          className={cn(inputStyles, "py-3")}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="confirm" className="text-sm font-medium">
          Repite la contraseña
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          aria-invalid={Boolean(state.error)}
          aria-describedby={state.error ? "password-error" : undefined}
          className={cn(inputStyles, "py-3")}
        />
        {state.error && (
          <p id="password-error" role="alert" className="animate-fade-in text-sm font-medium text-rose-600 dark:text-rose-400">
            {state.error}
          </p>
        )}
      </div>
      <button type="submit" disabled={pending} className={cn(buttonStyles.primary, "w-full py-3")}>
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {pending ? "Guardando…" : "Guardar y entrar"}
      </button>
    </form>
  );
}
