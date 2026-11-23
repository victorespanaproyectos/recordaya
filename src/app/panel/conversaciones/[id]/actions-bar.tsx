"use client";

import { Hand, LifeBuoy, LockKeyhole, RotateCcw, UserRoundCheck, UserRoundPlus, Bot as BotIcon, CircleCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import { buttonStyles, inputStyles } from "@/lib/panel/ui";
import type { ActionResult } from "../../actions";
import {
  claimConversationAction, closeConversationAction, declineHandoffAction, handoffConversationAction, reassignConversationAction,
  releaseConversationAction, resolveConversationAction, returnToBotAction,
} from "../actions";

interface Props {
  id: string;
  version: number;
  status: "bot" | "pending_human" | "human" | "resolved" | "closed";
  /** Rol del miembro y si tiene sesión de usuario real (la de demostración no puede tomar conversaciones). */
  isAdmin: boolean;
  isMember: boolean;
  isAssignee: boolean;
  members: { id: string; name: string }[];
  assignedId: string | null;
}

/** Botones según el estado y el rol (06 §18.3). Ocultar un botón no es seguridad: cada acción la vuelve a validar el servidor. */
export function ActionsBar({ id, version, status, isAdmin, isMember, isAssignee, members, assignedId }: Props) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [notify, setNotify] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [target, setTarget] = useState("");

  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    startTransition(async () => {
      const r = await fn();
      if (r.ok) {
        toast({ kind: "success", title: r.message ?? "Listo" });
        after?.();
      } else toast({ kind: "error", title: "No se pudo completar", description: r.error });
    });

  const handles = status === "human" && (isAssignee || isAdmin);
  const canClose = status !== "closed" && (isAdmin || (status === "human" && isAssignee));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isMember && ["bot", "pending_human", "resolved"].includes(status) && (
        <button type="button" disabled={pending} className={buttonStyles.primary} onClick={() => run(() => claimConversationAction(id, version))}>
          <Hand className="size-4" />
          Tomar
        </button>
      )}
      {status === "bot" && (
        <button type="button" disabled={pending} className={buttonStyles.secondary} onClick={() => run(() => handoffConversationAction(id, version))}>
          <LifeBuoy className="size-4" />
          Enviar a la cola
        </button>
      )}
      {status === "pending_human" && (
        <button type="button" disabled={pending} className={buttonStyles.secondary} onClick={() => run(() => declineHandoffAction(id, version))}>
          <BotIcon className="size-4" />
          Devolver a la IA
        </button>
      )}
      {handles && (
        <>
          <button type="button" disabled={pending} className={buttonStyles.secondary} onClick={() => run(() => releaseConversationAction(id, version))}>
            <RotateCcw className="size-4" />
            Liberar
          </button>
          <button type="button" disabled={pending} className={buttonStyles.secondary} onClick={() => run(() => returnToBotAction(id, notify, version))}>
            <BotIcon className="size-4" />
            Devolver a la IA
          </button>
          <button type="button" disabled={pending} className={buttonStyles.secondary} onClick={() => run(() => resolveConversationAction(id, notify, version))}>
            <CircleCheck className="size-4" />
            Resolver
          </button>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Avisar al cliente
          </label>
        </>
      )}
      {isAdmin && status === "human" && (
        <button type="button" disabled={pending} className={buttonStyles.secondary} onClick={() => setReassigning(true)}>
          <UserRoundPlus className="size-4" />
          Reasignar
        </button>
      )}
      {canClose && (
        <button type="button" disabled={pending} className={buttonStyles.ghost} onClick={() => setConfirmClose(true)}>
          <LockKeyhole className="size-4" />
          Cerrar
        </button>
      )}

      <Modal open={confirmClose} onClose={() => setConfirmClose(false)} title="¿Cerrar la conversación?" description="Queda en modo solo lectura. Si el cliente vuelve a escribir, se abre otra conversación.">
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonStyles.secondary} onClick={() => setConfirmClose(false)}>
            Cancelar
          </button>
          <button type="button" className={buttonStyles.danger} disabled={pending} onClick={() => run(() => closeConversationAction(id, version), () => setConfirmClose(false))}>
            Cerrar
          </button>
        </div>
      </Modal>

      <Modal open={reassigning} onClose={() => setReassigning(false)} title="Reasignar conversación" description="Pasa la conversación a otra persona del equipo sin devolverla a la cola.">
        <div className="space-y-4">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Nueva persona asignada" className={inputStyles}>
            <option value="">Elige a una persona</option>
            {members.filter((m) => m.id !== assignedId).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            <button type="button" className={buttonStyles.secondary} onClick={() => setReassigning(false)}>
              Cancelar
            </button>
            <button type="button" className={buttonStyles.primary} disabled={pending || !target} onClick={() => run(() => reassignConversationAction(id, target, version), () => setReassigning(false))}>
              <UserRoundCheck className="size-4" />
              Reasignar
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
