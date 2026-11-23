import { CalendarClock, Phone } from "lucide-react";
import Link from "next/link";
import type { ConversationDetail } from "@/lib/chatbot/panel-data";
import { capitalizeFirst, formatPhone } from "@/lib/panel/ui";
import { formatFecha, formatHora } from "@/lib/dates";

const REASON: Record<string, string> = {
  no_context: "Sin información",
  low_confidence: "Poca confianza",
  out_of_scope: "Fuera de tema",
  unsupported_content: "Contenido no soportado",
  handoff: "Derivada",
};

/** Datos del cliente, su próximo turno y las preguntas que el asistente no pudo responder en esta conversación. */
export function ContactPanel({ detail }: { detail: ConversationDetail }) {
  const { contact, nextAppointment, unanswered } = detail;
  return (
    <aside className="space-y-5 text-sm" aria-label="Datos del cliente">
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">{contact.name ?? formatPhone(contact.phone)}</h2>
        <a href={`tel:+${contact.phone}`} className="inline-flex items-center gap-1.5 text-muted hover:text-fg">
          <Phone className="size-4" />
          {formatPhone(contact.phone)}
        </a>
        <p className="text-xs text-muted">{contact.customerId ? "Cliente con turnos en el negocio" : "Todavía no tiene turnos"}</p>
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">Próximo turno</h3>
        {nextAppointment ? (
          <Link href={`/panel/turnos/${nextAppointment.id}`} className="flex items-start gap-2 rounded-xl border border-border p-3 hover:bg-surface-2">
            <CalendarClock className="mt-0.5 size-4 text-brand" />
            <span>
              {capitalizeFirst(formatFecha(new Date(nextAppointment.startsAt), nextAppointment.timezone))} · {formatHora(new Date(nextAppointment.startsAt), nextAppointment.timezone)}
              <span className="block text-xs text-muted">{nextAppointment.service ?? "Turno"}</span>
            </span>
          </Link>
        ) : (
          <p className="text-muted">Ninguno.</p>
        )}
      </section>
      <section className="space-y-1">
        <h3 className="font-medium">Preguntas sin respuesta ({unanswered.length})</h3>
        {unanswered.length === 0 ? (
          <p className="text-muted">Ninguna en esta conversación.</p>
        ) : (
          <ul className="space-y-2">
            {unanswered.map((u) => (
              <li key={u.id} className="rounded-xl border border-border p-2">
                <p>{u.question}</p>
                <p className="text-xs text-muted">
                  {REASON[u.reason] ?? u.reason} · {u.status === "open" ? "abierta" : u.status === "resolved" ? "resuelta" : "ignorada"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
