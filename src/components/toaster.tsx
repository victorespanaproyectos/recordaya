"use client";

import { CircleCheck, CircleAlert, TriangleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/panel/ui";

type ToastKind = "success" | "error" | "warning";
interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

const ToastContext = createContext<((t: Omit<Toast, "id">) => void) | null>(null);

export function useToast() {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast debe usarse dentro de <ToastProvider>");
  return push;
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId++;
      setToasts((all) => [...all.slice(-2), { ...toast, id }]);
      setTimeout(() => dismiss(id), toast.kind === "success" ? 4000 : 7000);
    },
    [dismiss],
  );

  return (
    <ToastContext value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="animate-rise pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card"
          >
            {t.kind === "success" && <CircleCheck className="mt-0.5 size-5 shrink-0 text-brand" />}
            {t.kind === "error" && <CircleAlert className="mt-0.5 size-5 shrink-0 text-rose-500" />}
            {t.kind === "warning" && <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-500" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t.title}</p>
              {t.description && <p className="mt-0.5 text-sm text-muted">{t.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className={cn("rounded-lg p-1 text-muted transition hover:bg-surface-2 hover:text-fg")}
              aria-label="Cerrar aviso"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  );
}
