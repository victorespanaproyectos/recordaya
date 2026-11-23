"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Vuelve a pedir la página cada `everyMs` (3 s por defecto) mientras `active` y la pestaña esté visible
 * (polling del panel, 06 §18). Al volver a la pestaña refresca de inmediato.
 */
export function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, everyMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, everyMs, router]);
  return null;
}
