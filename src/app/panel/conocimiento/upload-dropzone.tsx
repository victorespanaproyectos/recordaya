"use client";

import { createClient } from "@supabase/supabase-js";
import { LoaderCircle, Upload } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useToast } from "@/components/toaster";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { confirmUploadAction, requestUploadAction } from "./actions";
import { CATEGORY_LABEL } from "./labels";

const ACCEPT: Record<string, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain" };
const MAX_BYTES = 10 * 1024 * 1024;

/** Mismo tope que el servidor, solo para avisar antes de subir. La validación real está en el servidor. */
function mimeOf(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return ACCEPT[ext] ?? null;
}

/** Zona de arrastre: pide una URL firmada, sube directo a Storage y confirma en el servidor. */
export function UploadDropzone({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("other");
  const [busy, setBusy] = useState<"idle" | "uploading">("idle");
  const [dragging, setDragging] = useState(false);

  function pick(f: File | undefined) {
    if (!f) return;
    if (!mimeOf(f)) return toast({ kind: "error", title: "Tipo no admitido", description: "Usa PDF, Word (.docx) o texto (.txt)." });
    if (f.size > MAX_BYTES) return toast({ kind: "error", title: "Archivo muy grande", description: "El máximo es 10 MB." });
    setFile(f);
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
  }

  async function submit() {
    if (!file) return;
    const mimeType = mimeOf(file)!;
    setBusy("uploading");
    try {
      const req = await requestUploadAction({ name: file.name, mimeType, sizeBytes: file.size });
      if (!req.ok) return toast({ kind: "error", title: "No se pudo subir", description: req.error });

      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
      const { error } = await supabase.storage.from("knowledge").uploadToSignedUrl(req.path, req.token, file, { contentType: mimeType });
      if (error) return toast({ kind: "error", title: "No se pudo subir el archivo", description: "Intenta de nuevo." });

      const res = await confirmUploadAction({ path: req.path, title: title.trim() || file.name, category });
      if (!res.ok) return toast({ kind: "error", title: "No se pudo agregar", description: res.error });
      toast({ kind: "success", title: res.message ?? "Archivo recibido" });
      onDone();
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          pick(e.dataTransfer.files[0]);
        }}
        className={cn("flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center", dragging ? "border-brand bg-brand/5" : "border-border")}
      >
        <Upload className="size-6 text-muted" />
        <p className="text-sm">{file ? file.name : "Arrastra un archivo aquí"}</p>
        <p className="text-xs text-muted">PDF, Word (.docx) o texto (.txt), hasta 10 MB</p>
        <input ref={input} type="file" accept=".pdf,.docx,.txt" className="sr-only" id={`${id}-f`} onChange={(e) => pick(e.target.files?.[0])} />
        <button type="button" className={buttonStyles.secondary} onClick={() => input.current?.click()}>
          Elegir archivo
        </button>
      </div>
      {file && (
        <>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-t`} className="text-sm font-medium">
              Título
            </label>
            <input id={`${id}-t`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={inputStyles} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-c`} className="text-sm font-medium">
              Categoría
            </label>
            <select id={`${id}-c`} value={category} onChange={(e) => setCategory(e.target.value)} className={inputStyles}>
              {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          {busy === "uploading" && <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"><div className="h-full w-1/3 animate-pulse rounded-full bg-brand" /></div>}
          <button type="button" disabled={busy === "uploading"} onClick={submit} className={buttonStyles.primary}>
            {busy === "uploading" && <LoaderCircle className="size-4 animate-spin" />}
            Subir y procesar
          </button>
        </>
      )}
    </div>
  );
}
