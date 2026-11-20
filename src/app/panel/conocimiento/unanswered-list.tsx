"use client";

import { LoaderCircle, Plus, X } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import { buttonStyles, inputStyles } from "@/lib/panel/ui";
import { ignoreUnansweredAction, resolveUnansweredWithFaqAction } from "./actions";

export interface Group {
  question: string;
  ids: string[];
  count: number;
  reasons: string[];
}

const REASON: Record<string, string> = { no_context: "Sin información", low_confidence: "Poca confianza", out_of_scope: "Fuera de tema", unsupported_content: "Contenido no soportado", handoff: "Derivada" };

/** Preguntas que el asistente no pudo responder, agrupadas por parecido. Crear una FAQ resuelve todo el grupo. */
export function UnansweredList({ groups, canResolve }: { groups: Group[]; canResolve: boolean }) {
  const toast = useToast();
  const ids = useId();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<Group | null>(null);

  if (groups.length === 0) return <p className="rounded-2xl border border-border p-6 text-center text-sm text-muted">No hay preguntas sin respuesta. 🎉</p>;
  return (
    <>
      <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
        {groups.map((g) => (
          <li key={g.ids[0]} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{g.question}</p>
              <p className="text-xs text-muted">
                {g.count > 1 ? `${g.count} veces · ` : ""}
                {g.reasons.map((r) => REASON[r] ?? r).join(", ")}
              </p>
            </div>
            {canResolve && (
              <div className="flex gap-2">
                <button type="button" className={buttonStyles.secondary} onClick={() => setEditing(g)}>
                  <Plus className="size-4" />
                  Crear FAQ
                </button>
                <button
                  type="button"
                  className={buttonStyles.ghost}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const r = await ignoreUnansweredAction(g.ids);
                      toast(r.ok ? { kind: "success", title: r.message ?? "Listo" } : { kind: "error", title: "No se pudo ignorar", description: r.error });
                    })
                  }
                >
                  <X className="size-4" />
                  Ignorar
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <Modal open={editing !== null} onClose={() => setEditing(null)} variant="sheet" title="Crear FAQ" description="La respuesta que escribas se usará para contestar esta pregunta y las parecidas.">
        {editing && (
          <form
            key={editing.ids[0]}
            className="space-y-4"
            action={(form) =>
              startTransition(async () => {
                const r = await resolveUnansweredWithFaqAction({ ids: editing.ids, title: String(form.get("title")), question: String(form.get("question")), answer: String(form.get("answer")) });
                if (r.ok) {
                  toast({ kind: "success", title: r.message ?? "FAQ creada" });
                  setEditing(null);
                } else toast({ kind: "error", title: "No se pudo crear", description: r.error });
              })
            }
          >
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-t`} className="text-sm font-medium">
                Título
              </label>
              <input id={`${ids}-t`} name="title" required maxLength={200} defaultValue={editing.question.slice(0, 80)} className={inputStyles} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-q`} className="text-sm font-medium">
                Pregunta
              </label>
              <input id={`${ids}-q`} name="question" required maxLength={500} defaultValue={editing.question} className={inputStyles} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${ids}-a`} className="text-sm font-medium">
                Respuesta
              </label>
              <textarea id={`${ids}-a`} name="answer" required rows={6} maxLength={4000} className={inputStyles} />
            </div>
            <button type="submit" disabled={pending} className={buttonStyles.primary}>
              {pending && <LoaderCircle className="size-4 animate-spin" />}
              Crear FAQ
            </button>
          </form>
        )}
      </Modal>
    </>
  );
}
