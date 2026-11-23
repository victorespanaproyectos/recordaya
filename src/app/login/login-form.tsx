"use client";

import { ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useActionState, useState } from "react";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ legacy }: { legacy: boolean }) {
  const params = useSearchParams();
  const next = params.get("next") ?? "/panel";
  const linkError = params.get("error") === "enlace";
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  const [show, setShow] = useState(false);

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="next" value={next} />
      {linkError && (
        <p role="alert" className="text-sm font-medium text-rose-600 dark:text-rose-400">
          El enlace es inválido o venció. Pide una invitación nueva.
        </p>
      )}
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email{legacy ? " (opcional)" : ""}
        </label>
        <div className="relative">
          <Mail className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" />
          <input
            id="email"
            name="email"
            type="email"
            required={!legacy}
            autoComplete="username"
            placeholder="tu@email.com"
            aria-describedby={legacy ? "email-help" : undefined}
            className={cn(inputStyles, "py-3 pr-4 pl-10")}
          />
        </div>
        {legacy && (
          <p id="email-help" className="text-xs text-muted">
            Déjalo vacío para entrar con la contraseña compartida del panel (modo demo).
          </p>
        )}
      </div>
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          {legacy ? "Contraseña (o contraseña del panel)" : "Contraseña"}
        </label>
        <div className="relative">
          <LockKeyhole className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" />
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            required
            autoComplete="current-password"
            placeholder="••••••••"
            aria-invalid={Boolean(state.error)}
            aria-describedby={state.error ? "login-error" : undefined}
            className={cn(inputStyles, "py-3 pr-11 pl-10")}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-fg"
            aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        {state.error && (
          <p id="login-error" role="alert" className="animate-fade-in text-sm font-medium text-rose-600 dark:text-rose-400">
            {state.error}
          </p>
        )}
      </div>

      <button type="submit" disabled={pending} className={cn(buttonStyles.primary, "w-full py-3")}>
        {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
        {pending ? "Entrando…" : "Entrar al panel"}
        {!pending && <ArrowRight className="size-4" />}
      </button>
    </form>
  );
}
