"use client";

import { Pencil, Power, RotateCw, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import type { Source } from "@/lib/chatbot/rag/sources";
import { buttonStyles } from "@/lib/panel/ui";
import type { ActionResult } from "../actions";
import { deleteSourceAction, retrySourceAction, setSourceEnabledAction } from "./actions";
import { EditSourceForm } from "./source-form";

/** Editar, desactivar/activar, reintentar y eliminar (con confirmación). Solo se muestra a admin/owner. */
export function SourceActions({ source }: { source: Source }) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast({ kind: "success", title: result.message ?? "Listo" });
        after?.();
      } else toast({ kind: "error", title: "No se pudo completar", description: result.error });
    });

  const disabled = source.status === "disabled";
  return (
    <div className="flex items-center gap-1">
      {source.status === "failed" && (
        <button type="button" className={buttonStyles.ghost} disabled={pending} onClick={() => run(() => retrySourceAction(source.id))} aria-label={`Reintentar ${source.title}`}>
          <RotateCw className="size-4" />
          <span className="hidden lg:inline">Reintentar</span>
        </button>
      )}
      {source.type !== "file" && (
        <button type="button" className={buttonStyles.ghost} onClick={() => setEditing(true)} aria-label={`Editar ${source.title}`}>
          <Pencil className="size-4" />
        </button>
      )}
      <button type="button" className={buttonStyles.ghost} disabled={pending} onClick={() => run(() => setSourceEnabledAction(source.id, disabled))} aria-label={`${disabled ? "Activar" : "Desactivar"} ${source.title}`}>
        <Power className="size-4" />
      </button>
      <button type="button" className={buttonStyles.ghost} onClick={() => setConfirmingDelete(true)} aria-label={`Eliminar ${source.title}`}>
        <Trash2 className="size-4" />
      </button>

      <Modal open={editing} onClose={() => setEditing(false)} variant="sheet" title="Editar fuente" description="Si cambias el contenido, se vuelve a procesar; mientras tanto sigue respondiendo la versión anterior.">
        <EditSourceForm key={String(editing)} source={source} onDone={() => setEditing(false)} />
      </Modal>

      <Modal open={confirmingDelete} onClose={() => setConfirmingDelete(false)} title="¿Eliminar esta fuente?" description={`«${source.title}» dejará de usarse en las respuestas. Esta acción no se puede deshacer desde el panel.`}>
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonStyles.secondary} onClick={() => setConfirmingDelete(false)}>
            Cancelar
          </button>
          <button type="button" className={buttonStyles.danger} disabled={pending} onClick={() => run(() => deleteSourceAction(source.id), () => setConfirmingDelete(false))}>
            Eliminar
          </button>
        </div>
      </Modal>
    </div>
  );
}
