import { Sparkles } from "lucide-react";
import { Fragment } from "react";
import Link from "next/link";
import { MessageTicks } from "@/components/message-ticks";
import type { TimelineEntry } from "@/lib/chatbot/panel-data";
import { formatFecha, formatHora } from "@/lib/dates";
import { cn } from "@/lib/panel/ui";
import { EVENT_LABEL, REMINDER_LABEL } from "../labels";

/** Línea de tiempo unificada: mensajes del cliente (izquierda), del asistente y del equipo (derecha), recordatorios y eventos. */
export function ConversationTimeline({ entries, timeZone }: { entries: TimelineEntry[]; timeZone: string }) {
  // El separador de día se muestra cuando cambia el día respecto del elemento anterior.
  const days = entries.map((e) => formatFecha(new Date(e.at), timeZone));
  return (
    <ol className="space-y-3" aria-label="Historial de la conversación">
      {entries.map((e, i) => (
        <Fragment key={`${e.kind}-${e.id}`}>
          {days[i] !== days[i - 1] && <li className="py-1 text-center text-xs font-medium text-muted capitalize">{days[i]}</li>}
          <li>{renderEntry(e, new Date(e.at), timeZone)}</li>
        </Fragment>
      ))}
    </ol>
  );
}

function renderEntry(e: TimelineEntry, at: Date, tz: string) {
  const time = formatHora(at, tz);
  if (e.kind === "event") {
    const label = EVENT_LABEL[e.type] ?? e.type;
    const who = e.type === "claimed" && e.actorName ? ` ${e.actorName}` : "";
    return (
      <p className="text-center text-xs text-muted">
        {label}
        {who} · {time}
      </p>
    );
  }
  if (e.kind === "reminder") {
    return (
      <div className="mx-auto flex max-w-sm items-center justify-center gap-2 rounded-xl border border-dashed border-border px-3 py-1.5 text-xs text-muted">
        <span>{REMINDER_LABEL[e.reminderKind] ?? e.reminderKind}</span>
        <MessageTicks status={e.status} />
        {e.appointmentId && (
          <Link href={`/panel/turnos/${e.appointmentId}`} className="font-medium text-brand hover:underline">
            ver turno
          </Link>
        )}
        <span>· {time}</span>
      </div>
    );
  }
  if (e.sender === "system") {
    return (
      <p className="text-center text-xs text-muted">
        {e.body} · {time}
      </p>
    );
  }
  const mine = e.direction === "outbound";
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", mine ? (e.sender === "bot" ? "bg-emerald-500/10" : "bg-brand text-brand-fg") : "bg-surface-2")}>
        {mine && (
          <p className={cn("mb-0.5 flex items-center gap-1 text-xs font-semibold", e.sender === "bot" ? "text-emerald-700 dark:text-emerald-300" : "opacity-80")}>
            {e.sender === "bot" ? (
              <>
                <Sparkles className="size-3" aria-hidden /> Asistente
              </>
            ) : (
              (e.senderName ?? "Equipo")
            )}
          </p>
        )}
        <p className="break-words whitespace-pre-wrap">{e.body ?? `(${e.contentType})`}</p>
        <p className={cn("mt-1 flex items-center justify-end gap-1.5 text-xs", mine && e.sender !== "bot" ? "opacity-80" : "text-muted")}>
          {e.sources.length > 0 && <span title="Fuentes citadas">fuentes: {e.sources.join(", ")} ·</span>}
          {time}
          {mine && <MessageTicks status={e.status} />}
        </p>
      </div>
    </div>
  );
}
