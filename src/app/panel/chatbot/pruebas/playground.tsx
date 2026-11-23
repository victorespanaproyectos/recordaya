"use client";

import { LoaderCircle, RotateCcw, Send } from "lucide-react";
import { useState, useTransition } from "react";
import { useToast } from "@/components/toaster";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { testChatbotAction, type PlaygroundResult } from "./actions";

interface Turn {
  role: "user" | "assistant";
  text: string;
  result?: PlaygroundResult;
}

/** Chat de prueba con depuración: fragmentos usados, JSON del modelo, guarda aplicada y costo. */
export function Playground() {
  const toast = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();

  function send() {
    const text = draft.trim();
    if (!text || pending) return;
    const next: Turn[] = [...turns, { role: "user", text }];
    setTurns(next);
    setDraft("");
    startTransition(async () => {
      const result = await testChatbotAction(next.map(({ role, text }) => ({ role, text })));
      if (!result.ok) {
        toast({ kind: "error", title: "No se pudo probar", description: result.error });
        setTurns(turns); // se deshace el mensaje para poder reintentar
        setDraft(text);
        return;
      }
      setTurns([...next, { role: "assistant", text: result.reply ?? `(sin respuesta: ${result.skipped})`, result }]);
    });
  }

  const last = [...turns].reverse().find((t) => t.result)?.result;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="flex min-h-96 flex-col rounded-2xl border border-border">
        <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
          {turns.length === 0 && <p className="text-sm text-muted">Escribe una pregunta para empezar, por ejemplo «¿a qué hora abren?».</p>}
          {turns.map((t, i) => (
            <div key={i} className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap", t.role === "user" ? "ml-auto bg-brand text-brand-fg" : "bg-emerald-500/10")}>
              {t.text}
              {t.result?.handoffButtons && <p className="mt-2 text-xs text-muted">[Sí, con una persona] [No, sigo aquí]</p>}
            </div>
          ))}
          {pending && <LoaderCircle className="size-4 animate-spin text-muted" aria-label="Pensando" />}
        </div>
        <form
          className="flex gap-2 border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} placeholder="Escribe como un cliente…" aria-label="Mensaje de prueba" className={inputStyles} />
          <button type="submit" disabled={pending || !draft.trim()} className={buttonStyles.primary} aria-label="Enviar">
            <Send className="size-4" />
          </button>
          <button type="button" onClick={() => setTurns([])} disabled={pending || turns.length === 0} className={buttonStyles.secondary} aria-label="Empezar de nuevo">
            <RotateCcw className="size-4" />
          </button>
        </form>
      </div>

      <aside className="space-y-4 text-sm" aria-label="Depuración">
        <h2 className="text-lg font-semibold">Depuración</h2>
        {!last ? (
          <p className="text-muted">Aparece después de la primera respuesta.</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-muted">Modelo</dt>
              <dd className="break-all">{last.model ?? "—"}</dd>
              <dt className="text-muted">Tokens (entrada / caché / salida)</dt>
              <dd>{last.tokens ? `${last.tokens.input} / ${last.tokens.cacheRead} / ${last.tokens.output}` : "—"}</dd>
              <dt className="text-muted">Costo estimado</dt>
              <dd>US$ {(last.costUsd ?? 0).toFixed(6)}</dd>
              <dt className="text-muted">Guarda</dt>
              <dd>{last.guard ?? "ninguna"}</dd>
              <dt className="text-muted">Fuentes citadas</dt>
              <dd>{last.usedSourceIds?.join(", ") || "ninguna"}</dd>
            </dl>
            <div>
              <h3 className="mb-1 font-medium">Fragmentos recuperados ({last.chunks?.length ?? 0})</h3>
              <ul className="space-y-2">
                {last.chunks?.map((c) => (
                  <li key={c.ref} className="rounded-xl border border-border p-2">
                    <p className="text-xs text-muted">
                      {c.ref} · {c.title} · similitud {c.similarity.toFixed(2)}
                    </p>
                    <p className="line-clamp-4 whitespace-pre-wrap">{c.content}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-medium">Salida del modelo (JSON)</h3>
              <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-surface-2 p-3 text-xs whitespace-pre-wrap">{JSON.stringify(last.output, null, 2)}</pre>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
