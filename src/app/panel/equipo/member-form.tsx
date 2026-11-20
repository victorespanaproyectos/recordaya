"use client";

import { LoaderCircle, Pencil, Plus } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import { canManageRole, type Role } from "@/lib/auth/permissions";
import { buttonStyles, inputStyles } from "@/lib/panel/ui";
import { inviteMemberAction, updateMemberAction } from "./actions";

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", operator: "Operador" };
const ROLE_HELP: Record<Role, string> = {
  owner: "Todo, incluido el modelo de IA, el tope de gasto y los demás owners.",
  admin: "Conocimiento, configuración del chatbot, equipo (salvo owners) y reasignar o cerrar conversaciones.",
  operator: "Atiende conversaciones, ve la agenda y lee el conocimiento y las métricas (sin costos).",
};
const roles = (actor: Role): Role[] => (["operator", "admin", "owner"] as const).filter((r) => canManageRole(actor, r));

export function InviteMemberButton({ actorRole }: { actorRole: Role }) {
  const toast = useToast();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [role, setRole] = useState<Role>("operator");

  return (
    <>
      <button type="button" className={buttonStyles.primary} onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Invitar
      </button>
      <Modal open={open} onClose={() => setOpen(false)} variant="sheet" title="Invitar a una persona" description="Le llega un email para elegir su contraseña y entrar al panel.">
        <form
          className="space-y-4"
          action={(form) =>
            startTransition(async () => {
              const r = await inviteMemberAction({ email: String(form.get("email")), name: String(form.get("name")), role });
              if (r.ok) {
                toast({ kind: "success", title: r.message ?? "Invitación enviada" });
                setOpen(false);
              } else toast({ kind: "error", title: "No se pudo invitar", description: r.error });
            })
          }
        >
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-n`} className="text-sm font-medium">
              Nombre
            </label>
            <input id={`${ids}-n`} name="name" required maxLength={80} className={inputStyles} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-e`} className="text-sm font-medium">
              Email
            </label>
            <input id={`${ids}-e`} name="email" type="email" required autoComplete="off" className={inputStyles} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-r`} className="text-sm font-medium">
              Rol
            </label>
            <select id={`${ids}-r`} value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputStyles}>
              {roles(actorRole).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted">{ROLE_HELP[role]}</p>
          </div>
          <button type="submit" disabled={pending} className={buttonStyles.primary}>
            {pending && <LoaderCircle className="size-4 animate-spin" />}
            Enviar invitación
          </button>
        </form>
      </Modal>
    </>
  );
}

export interface EditableMember {
  id: string;
  displayName: string;
  email: string;
  role: Role;
  status: "invited" | "active" | "disabled";
  maxConcurrent: number;
}

export function EditMemberButton({ member, actorRole }: { member: EditableMember; actorRole: Role }) {
  const toast = useToast();
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [role, setRole] = useState<Role>(member.role);
  const [max, setMax] = useState(member.maxConcurrent);
  const editable = canManageRole(actorRole, member.role);
  if (!editable) return null;

  const save = (patch: { role?: string; maxConcurrent?: number; status?: string }, close = true) =>
    startTransition(async () => {
      const r = await updateMemberAction(member.id, patch);
      if (r.ok) {
        toast({ kind: "success", title: r.message ?? "Guardado" });
        if (close) setOpen(false);
      } else toast({ kind: "error", title: "No se pudo guardar", description: r.error });
    });

  return (
    <>
      <button type="button" className={buttonStyles.ghost} onClick={() => setOpen(true)} aria-label={`Editar a ${member.displayName}`}>
        <Pencil className="size-4" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={member.displayName} description={member.email}>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-r`} className="text-sm font-medium">
              Rol
            </label>
            <select id={`${ids}-r`} value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputStyles}>
              {roles(actorRole).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted">{ROLE_HELP[role]}</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${ids}-m`} className="text-sm font-medium">
              Conversaciones simultáneas (máximo)
            </label>
            <input id={`${ids}-m`} type="number" min={1} max={50} value={max} onChange={(e) => setMax(Number(e.target.value))} className={`${inputStyles} w-28`} />
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            {member.status !== "invited" && (
              <button type="button" disabled={pending} className={member.status === "disabled" ? buttonStyles.secondary : buttonStyles.danger} onClick={() => save({ status: member.status === "disabled" ? "active" : "disabled" })}>
                {member.status === "disabled" ? "Reactivar" : "Desactivar"}
              </button>
            )}
            <button type="button" disabled={pending} className={buttonStyles.primary} onClick={() => save({ ...(role !== member.role && { role }), ...(max !== member.maxConcurrent && { maxConcurrent: max }) })}>
              {pending && <LoaderCircle className="size-4 animate-spin" />}
              Guardar
            </button>
          </div>
          {member.status === "disabled" && <p className="text-xs text-muted">Desactivar a una persona libera sus conversaciones: vuelven a la cola.</p>}
        </div>
      </Modal>
    </>
  );
}
