import { ArrowLeft, CalendarClock, MapPin, MessageCircle, Phone, Scissors, StickyNote } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MessageTicks } from "@/components/message-ticks";
import { StatusBadge } from "@/components/status-badge";
import { formatFecha, formatHora, timeAgo } from "@/lib/dates";
import { requireMember } from "@/lib/auth/session";
import { getAppointmentDetail, timelineAt, type AppointmentDetail } from "@/lib/panel/data";
import { buttonStyles, capitalizeFirst, cn, formatPhone, INTENT_LABEL, initials, MESSAGE_KIND, MESSAGE_STATUS } from "@/lib/panel/ui";
import { AppointmentActions } from "../../appointment-actions";

export const metadata: Metadata = { title: "Turno · RecordaYa" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AppointmentPage({ params }: PageProps<"/panel/turnos/[id]">) {
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/panel" className={cn(buttonStyles.ghost, "-ml-3 mb-6")}>
        <ArrowLeft className="size-4" />
        Volver a la agenda
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <Detail params={params} />
      </Suspense>
    </div>
  );
}

async function Detail({ params }: { params: PageProps<"/panel/turnos/[id]">["params"] }) {
  const member = await requireMember("operator");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const appt = await getAppointmentDetail(id, member.businessId);
  if (!appt) notFound();

  const tz = appt.business.timezone;
  const start = new Date(appt.starts_at);
  const waLink = `https://wa.me/${appt.customer.phone}`;

  return (
    <div className="space-y-6">
      {/* Cabecera */}
      <section className="animate-rise overflow-hidden rounded-3xl border border-border bg-surface shadow-card">
        <div className="relative bg-gradient-to-br from-brand-soft via-surface to-surface p-6 sm:p-8">
          <div className="flex flex-wrap items-start gap-5">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-brand text-lg font-bold text-brand-fg shadow-sm">
              {initials(appt.customer.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{appt.customer.name}</h1>
                <StatusBadge status={appt.status} />
              </div>
              <p className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarClock className="size-4" />
                  <span>{capitalizeFirst(formatFecha(start, tz))}</span> · {formatHora(start, tz)}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Scissors className="size-4" />
                  {appt.service ?? "Turno"}
                </span>
                <a href={`tel:+${appt.customer.phone}`} className="inline-flex items-center gap-1.5 hover:text-fg">
                  <Phone className="size-4" />
                  {formatPhone(appt.customer.phone)}
                </a>
              </p>
            </div>
            <a href={waLink} target="_blank" rel="noreferrer" className={buttonStyles.secondary}>
              <MessageCircle className="size-4 text-brand" />
              Abrir chat
            </a>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-6 py-4 sm:px-8">
          <AppointmentActions
            id={appt.id}
            status={appt.status}
            startsAt={appt.starts_at}
            timeZone={tz}
            customerName={appt.customer.name}
            layout="bar"
          />
          <p className="text-xs text-muted">
            {appt.business.name}
            {appt.business.address && (
              <span className="ml-2 inline-flex items-center gap-1">
                <MapPin className="size-3" />
                {appt.business.address}
              </span>
            )}
          </p>
        </div>
        {appt.notes && (
          <p className="flex items-start gap-2 border-t border-border bg-amber-500/5 px-6 py-3 text-sm sm:px-8">
            <StickyNote className="mt-0.5 size-4 shrink-0 text-amber-600" />
            {appt.notes}
          </p>
        )}
      </section>

      {/* Conversación */}
      <section className="animate-rise rounded-3xl border border-border bg-surface shadow-card" style={{ animationDelay: "80ms" }}>
        <header className="flex items-center justify-between border-b border-border px-6 py-4 sm:px-8">
          <h2 className="font-semibold">Mensajes de WhatsApp</h2>
          <span className="text-xs text-muted">{appt.timeline.length} eventos</span>
        </header>
        <Conversation appt={appt} />
      </section>
    </div>
  );
}

function Conversation({ appt }: { appt: AppointmentDetail }) {
  const tz = appt.business.timezone;
  if (appt.timeline.length === 0) {
    return <p className="px-6 py-10 text-center text-sm text-muted">Todavía no hay mensajes para este turno.</p>;
  }

  return (
    <ol className="space-y-4 bg-[#efeae2]/60 px-4 py-6 sm:px-8 dark:bg-[#0b141a]/60">
      {appt.timeline.map((item) => {
        const at = new Date(timelineAt(item));

        if (item.direction === "in") {
          return (
            <li key={item.id} className="flex flex-col items-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white px-4 py-2.5 text-sm text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
                {item.body ?? "(mensaje sin texto)"}
                <span className="mt-1 block text-right text-[11px] text-[#667781]">{formatHora(at, tz)}</span>
              </div>
              <span className="mt-1 ml-1 text-xs font-medium text-muted">
                {appt.customer.name.split(" ")[0]} · {INTENT_LABEL[item.intent ?? "unknown"] ?? "Escribió"}
              </span>
            </li>
          );
        }

        const pending = item.status === "queued" || item.status === "cancelled";
        const text = item.variables?.body ?? summarize(item.kind, item.variables);
        return (
          <li key={item.id} className="flex flex-col items-end">
            <div
              className={cn(
                "max-w-[85%] rounded-2xl rounded-tr-md px-4 py-2.5 text-sm shadow-sm",
                pending
                  ? "border border-dashed border-[#667781]/40 bg-white/60 text-[#54656f] dark:bg-[#005c4b]/30 dark:text-[#aebac1]"
                  : "bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]",
              )}
            >
              <span className="mb-1 block text-xs font-semibold text-brand-strong dark:text-[#7ae3c3]">
                {MESSAGE_KIND[item.kind] ?? item.kind}
              </span>
              {text}
              <span className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-[#667781] dark:text-[#aebac1]">
                {item.status === "queued" ? `Programado · ${formatFecha(at, tz)} ${formatHora(at, tz)}` : formatHora(at, tz)}
                <MessageTicks status={item.status} className={item.status === "read" ? "!text-sky-500" : ""} />
              </span>
            </div>
            <span className={cn("mt-1 mr-1 text-xs font-medium", MESSAGE_STATUS[item.status]?.className)}>
              {MESSAGE_STATUS[item.status]?.label}
              {item.status === "failed" && item.error?.message ? ` · ${item.error.message}` : ""}
              {item.read_at && item.status === "read" ? ` ${timeAgo(new Date(item.read_at))}` : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Texto aproximado del mensaje enviado, a partir de las variables de la plantilla. */
function summarize(kind: string, v: Record<string, string>): string {
  if (!v || Object.keys(v).length === 0) {
    return kind.startsWith("reminder") ? "Recordatorio del turno con opción de confirmar (1) o cancelar (2)." : "—";
  }
  switch (kind) {
    case "confirmation":
      return `Hola ${v.nombre}, gracias por reservar con ${v.negocio}. Se confirma tu cita para ${v.servicio} el ${v.fecha} a las ${v.hora}.`;
    case "cancellation":
      return `Hola ${v.nombre}, tu cita con ${v.negocio} del ${v.fecha} a las ${v.hora} fue cancelada.`;
    case "reminder_24h":
    case "reminder_2h":
      return v.nombre
        ? `Hola ${v.nombre}, te recordamos tu turno del ${v.fecha} a las ${v.hora} en ${v.negocio}. Respondé 1 para confirmar o 2 para cancelar.`
        : `Recordatorio: confirmaste ${v.servicio} en ${v.negocio}, el ${v.fecha} a las ${v.hora}.`;
    default:
      return Object.values(v).join(" · ");
  }
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-52 animate-pulse rounded-3xl bg-surface-2" />
      <div className="h-96 animate-pulse rounded-3xl bg-surface-2" />
    </div>
  );
}
