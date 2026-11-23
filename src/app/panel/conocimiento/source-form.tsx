"use client";

import { FileText, Globe, LoaderCircle, MessageCircleQuestion, Plus } from "lucide-react";
import { useActionState, useEffect, useId, useState, type ReactNode } from "react";
import { Modal } from "@/components/modal";
import { useToast } from "@/components/toaster";
import type { Source } from "@/lib/chatbot/rag/sources";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import type { ActionResult } from "../actions";
import { createSourceAction, updateSourceAction } from "./actions";
import { CATEGORY_LABEL } from "./labels";
import { UploadDropzone } from "./upload-dropzone";

type NewKind = "faq" | "text" | "url" | "file";

const KINDS: { id: NewKind; label: string; icon: ReactNode }[] = [
  { id: "faq", label: "Pregunta frecuente", icon: <MessageCircleQuestion className="size-4" /> },
  { id: "text", label: "Texto", icon: <FileText className="size-4" /> },
  { id: "file", label: "Archivo", icon: <FileText className="size-4" /> },
  { id: "url", label: "Página web", icon: <Globe className="size-4" /> },
];

/** Botón "Agregar" con el formulario de creación (en un panel lateral). */
export function AddSourceButton() {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      <button
        type="button"
        className={buttonStyles.primary}
        onClick={() => {
          setFormKey((k) => k + 1);
          setOpen(true);
        }}
      >
        <Plus className="size-4" />
        Agregar
      </button>
      <Modal open={open} onClose={() => setOpen(false)} variant="sheet" title="Agregar conocimiento" description="Lo que el asistente puede responder a tus clientes.">
        <NewSourceForm key={formKey} onDone={() => setOpen(false)} />
      </Modal>
    </>
  );
}

function NewSourceForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const ids = useId();
  const [kind, setKind] = useState<NewKind>("faq");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(createSourceAction, null);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast({ kind: "success", title: state.message ?? "Listo" });
      onDone();
    } else toast({ kind: "error", title: "No se pudo guardar", description: state.error });
  }, [state, toast, onDone]);

  return (
    <div className="space-y-5">
      <div role="tablist" className="flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={kind === k.id}
            onClick={() => setKind(k.id)}
            className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm", kind === k.id ? "border-brand bg-brand/10 font-medium" : "border-border text-muted")}
          >
            {k.icon}
            {k.label}
          </button>
        ))}
      </div>

      {kind === "file" ? (
        <UploadDropzone onDone={onDone} />
      ) : (
        <form action={action} className="space-y-4">
          <input type="hidden" name="type" value={kind} />
          <Field label="Título" htmlFor={`${ids}-t`}>
            <input id={`${ids}-t`} name="title" required maxLength={200} className={inputStyles} />
          </Field>
          <CategorySelect id={`${ids}-c`} defaultValue={kind === "faq" ? "faq" : "other"} />
          {kind === "faq" && (
            <>
              <Field label="Pregunta" htmlFor={`${ids}-q`}>
                <input id={`${ids}-q`} name="question" required maxLength={500} className={inputStyles} />
              </Field>
              <Field label="Respuesta" htmlFor={`${ids}-a`}>
                <textarea id={`${ids}-a`} name="answer" required rows={5} maxLength={4000} className={inputStyles} />
              </Field>
            </>
          )}
          {kind === "text" && (
            <Field label="Texto" htmlFor={`${ids}-b`} hint="Hasta 50 000 caracteres.">
              <textarea id={`${ids}-b`} name="body" required rows={10} maxLength={50000} className={inputStyles} />
            </Field>
          )}
          {kind === "url" && (
            <Field label="Dirección" htmlFor={`${ids}-u`} hint="Debe empezar con https://. Se lee el texto principal de la página.">
              <input id={`${ids}-u`} name="url" type="url" required placeholder="https://" className={inputStyles} />
            </Field>
          )}
          <button type="submit" disabled={pending} className={buttonStyles.primary}>
            {pending && <LoaderCircle className="size-4 animate-spin" />}
            Agregar
          </button>
        </form>
      )}
    </div>
  );
}

/** Edita título y categoría (siempre) y el contenido (FAQ, texto y página web; los archivos se reemplazan subiendo otro). */
export function EditSourceForm({ source, onDone }: { source: Source; onDone: () => void }) {
  const toast = useToast();
  const ids = useId();
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(updateSourceAction, null);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast({ kind: "success", title: state.message ?? "Guardado" });
      onDone();
    } else toast({ kind: "error", title: "No se pudo guardar", description: state.error });
  }, [state, toast, onDone]);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={source.id} />
      <Field label="Título" htmlFor={`${ids}-t`}>
        <input id={`${ids}-t`} name="title" required maxLength={200} defaultValue={source.title} className={inputStyles} />
      </Field>
      <CategorySelect id={`${ids}-c`} defaultValue={source.category} />
      {source.type === "faq" && (
        <>
          <Field label="Pregunta" htmlFor={`${ids}-q`}>
            <input id={`${ids}-q`} name="question" required maxLength={500} defaultValue={source.faqQuestion ?? ""} className={inputStyles} />
          </Field>
          <Field label="Respuesta" htmlFor={`${ids}-a`}>
            <textarea id={`${ids}-a`} name="answer" required rows={5} maxLength={4000} defaultValue={source.faqAnswer ?? ""} className={inputStyles} />
          </Field>
        </>
      )}
      {source.type === "text" && (
        <Field label="Texto" htmlFor={`${ids}-b`}>
          <textarea id={`${ids}-b`} name="body" required rows={10} maxLength={50000} defaultValue={source.body ?? ""} className={inputStyles} />
        </Field>
      )}
      {source.type === "url" && (
        <Field label="Dirección" htmlFor={`${ids}-u`}>
          <input id={`${ids}-u`} name="url" type="url" required defaultValue={source.url ?? ""} className={inputStyles} />
        </Field>
      )}
      <button type="submit" disabled={pending} className={buttonStyles.primary}>
        {pending && <LoaderCircle className="size-4 animate-spin" />}
        Guardar
      </button>
    </form>
  );
}

function CategorySelect({ id, defaultValue }: { id: string; defaultValue: string }) {
  return (
    <Field label="Categoría" htmlFor={id}>
      <select id={id} name="category" defaultValue={defaultValue} className={inputStyles}>
        {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
