"use client";

import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/panel/ui";

/**
 * Modal sobre <dialog> nativo: foco atrapado, Escape y backdrop accesibles sin dependencias.
 * variant "sheet" = panel lateral (en móvil ocupa toda la pantalla).
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  variant = "center",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  variant?: "center" | "sheet";
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // clic en el backdrop
      }}
      aria-labelledby="modal-title"
      className={cn(
        "bg-transparent p-0 text-fg backdrop:bg-black/40 backdrop:backdrop-blur-[2px]",
        variant === "sheet"
          ? "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-lg overflow-hidden"
          : "m-auto w-[calc(100%-2rem)] max-w-md overflow-visible",
      )}
    >
      {open && (
        <div
          className={cn(
            "flex flex-col bg-surface shadow-card",
            variant === "sheet"
              ? "animate-slide-in h-full border-l border-border"
              : "animate-rise rounded-3xl border border-border",
          )}
        >
          <header className="flex items-start gap-4 border-b border-border px-6 py-5">
            <div className="min-w-0 flex-1">
              <h2 id="modal-title" className="text-lg font-bold tracking-tight">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 rounded-xl p-2 text-muted transition hover:bg-surface-2 hover:text-fg"
              aria-label="Cerrar"
            >
              <X className="size-5" />
            </button>
          </header>
          <div
            className={cn(
              "px-6",
              variant === "sheet" ? "min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-5" : "py-5",
            )}
          >
            {children}
          </div>
        </div>
      )}
    </dialog>
  );
}
