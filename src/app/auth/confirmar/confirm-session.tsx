"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

/** Lee los tokens del fragmento `#…` del enlace de Supabase y los entrega al servidor. */
export function ConfirmSession() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    // Quita los tokens de la barra de direcciones y del historial cuanto antes.
    window.history.replaceState(null, "", window.location.pathname);

    if (!accessToken || !refreshToken) {
      window.location.replace("/login?error=enlace");
      return;
    }

    fetch("/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, type: params.get("type") }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("rechazado");
        const { redirect } = (await res.json()) as { redirect: string };
        window.location.replace(redirect);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <p role="alert" className="text-sm font-medium text-rose-600 dark:text-rose-400">
        El enlace es inválido o venció. Pide una invitación nueva.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-2 text-muted" role="status">
      <LoaderCircle className="size-4 animate-spin" /> Verificando tu enlace…
    </p>
  );
}
