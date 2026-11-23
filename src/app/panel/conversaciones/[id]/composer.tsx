"use client";

import { LoaderCircle, Send } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { useToast } from "@/components/toaster";
import { buttonStyles, inputStyles } from "@/lib/panel/ui";
import { sendAgentMessageAction, sendReopenTemplateAction } from "../actions";

function remaining(closesAt: string | null, now: number): string | null {
  if (!closesAt) return null;
  const ms = new Date(closesAt).getTime() - now;
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Compositor: solo habilitado si la conversación está en `human` y es mía. Enter envía; Shift+Enter hace un salto. */
export function Composer({ id, enabled, reason, windowClosesAt, hasTemplate }: { id: string; enabled: boolean; reason: string; windowClosesAt: string | null; hasTemplate: boolean }) {
  const toast = useToast();
  const [text, setText] = useState("");
  // El identificador se conserva hasta que el envío sale bien: un reintento o un doble clic no duplica el mensaje.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [pending, startTransition] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const left = remaining(windowClosesAt, now);
  const windowOpen = left !== null;

  function send() {
    const body = text.trim();
    if (!body || pending) return;
    startTransition(async () => {
      const r = await sendAgentMessageAction(id, body, requestId);
      if (r.ok) {
        setText("");
        setRequestId(crypto.randomUUID());
      } else toast({ kind: "error", title: "No se pudo enviar", description: r.error });
    });
  }

  if (!enabled) return <p className="rounded-xl border border-border bg-surface-2 p-3 text-sm text-muted">{reason}</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">{windowOpen ? `Puedes responder con texto libre durante ${left} más.` : "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite una plantilla de reapertura."}</p>
      {windowOpen ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            maxLength={4096}
            aria-label="Mensaje al cliente"
            placeholder="Escribe un mensaje… (Enter envía, Shift+Enter salta de línea)"
            className={inputStyles}
          />
          <button type="submit" disabled={pending || !text.trim()} className={buttonStyles.primary} aria-label="Enviar">
            {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </form>
      ) : hasTemplate ? (
        <button
          type="button"
          disabled={pending}
          className={buttonStyles.secondary}
          onClick={() =>
            startTransition(async () => {
              const r = await sendReopenTemplateAction(id, requestId);
              if (r.ok) {
                toast({ kind: "success", title: "Plantilla enviada", description: "Cuando el cliente responda podrás escribirle con texto libre." });
                setRequestId(crypto.randomUUID());
              } else toast({ kind: "error", title: "No se pudo enviar", description: r.error });
            })
          }
        >
          Enviar plantilla para retomar la conversación
        </button>
      ) : (
        <p className="text-sm text-muted">La plantilla de reapertura todavía no está configurada.</p>
      )}
    </div>
  );
}
