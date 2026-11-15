import {
  BellRing,
  CalendarCheck2,
  CalendarDays,
  CalendarX2,
  ChevronRight,
  History,
  MailCheck,
  MessageCircleReply,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MessageTicks } from "@/components/message-ticks";
import { StatusBadge } from "@/components/status-badge";
import { formatHora, relativeDayLabel, dayKey, timeAgo } from "@/lib/dates";
import { requirePanelSession } from "@/lib/panel/auth";
import {
  getAgenda,
  getBusinesses,
  getRecentActivity,
  getStats,
  type AgendaItem,
  type AgendaView,
} from "@/lib/panel/data";
import { capitalizeFirst, cn, formatPhone, INTENT_LABEL, initials } from "@/lib/panel/ui";
import { AppointmentActions } from "./appointment-actions";
import { NewAppointmentButton } from "./new-appointment";

export const metadata: Metadata = { title: "Agenda · RecordaYa" };

const VIEWS: { id: AgendaView; label: string; icon: React.ReactNode }[] = [
  { id: "upcoming", label: "Próximos", icon: <CalendarDays className="size-4" /> },
  { id: "past", label: "Pasados", icon: <History className="size-4" /> },
  { id: "cancelled", label: "Cancelados", icon: <CalendarX2 className="size-4" /> },
];

export default function PanelPage({ searchParams }: PageProps<"/panel">) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/panel">["searchParams"] }) {
  await requirePanelSession();
  const params = await searchParams;
  const view = (VIEWS.find((v) => v.id === params.vista)?.id ?? "upcoming") as AgendaView;
  const businesses = await getBusinesses();
  const tz = businesses[0]?.timezone ?? "America/Montevideo";

  return (
    <div className="space-y-8">
      <div className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-brand">{businesses[0]?.name ?? "Tu negocio"}</p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">Agenda</h1>
          <p className="mt-1 text-muted">{capitalizeFirst(relativeDayLabelLong(tz))}</p>
        </div>
        <NewAppointmentButton businesses={businesses} />
      </div>

      <Suspense fallback={<StatsSkeleton />}>
        <Stats timeZone={tz} />
      </Suspense>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="agenda-title">
          <h2 id="agenda-title" className="sr-only">
            Turnos
          </h2>
          <nav className="mb-5 inline-flex rounded-2xl border border-border bg-surface p-1" aria-label="Filtrar turnos">
            {VIEWS.map((v) => (
              <Link
                key={v.id}
                href={v.id === "upcoming" ? "/panel" : `/panel?vista=${v.id}`}
                aria-current={v.id === view ? "page" : undefined}
                className={cn(
                  "inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition",
                  v.id === view ? "bg-brand text-brand-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {v.icon}
                {v.label}
              </Link>
            ))}
          </nav>
          <Suspense key={view} fallback={<AgendaSkeleton />}>
            <Agenda view={view} />
          </Suspense>
        </section>

        <aside aria-labelledby="activity-title" className="space-y-4">
          <h2 id="activity-title" className="text-sm font-semibold tracking-wider text-muted uppercase">
            Actividad reciente
          </h2>
          <Suspense fallback={<ActivitySkeleton />}>
            <Activity />
          </Suspense>
        </aside>
      </div>
    </div>
  );
}

function relativeDayLabelLong(tz: string) {
  return new Intl.DateTimeFormat("es-UY", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(
    new Date(),
  );
}

/* ── Métricas ─────────────────────────────────────────────── */

async function Stats({ timeZone }: { timeZone: string }) {
  const s = await getStats(timeZone);
  const cards = [
    {
      label: "Turnos hoy",
      value: s.today,
      hint: `${s.next7Days} en los próximos 7 días`,
      icon: <CalendarCheck2 className="size-5" />,
      tone: "from-emerald-500/15 to-emerald-500/0 text-emerald-600 dark:text-emerald-300",
    },
    {
      label: "Tasa de confirmación",
      value: s.confirmationRate === null ? "—" : `${s.confirmationRate}%`,
      hint: "Últimos 30 días",
      icon: <TrendingUp className="size-5" />,
      tone: "from-sky-500/15 to-sky-500/0 text-sky-600 dark:text-sky-300",
    },
    {
      label: "Mensajes leídos",
      value: s.readRate === null ? "—" : `${s.readRate}%`,
      hint: `${s.sentLast7Days} enviados esta semana`,
      icon: <MailCheck className="size-5" />,
      tone: "from-violet-500/15 to-violet-500/0 text-violet-600 dark:text-violet-300",
    },
    {
      label: "Recordatorios en cola",
      value: s.pendingReminders,
      hint: "Se envían solos 24 h y 2 h antes",
      icon: <BellRing className="size-5" />,
      tone: "from-amber-500/15 to-amber-500/0 text-amber-600 dark:text-amber-300",
    },
  ];

  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {cards.map((c, i) => (
        <li
          key={c.label}
          style={{ animationDelay: `${i * 50}ms` }}
          className="animate-rise relative overflow-hidden rounded-3xl border border-border bg-surface p-4 shadow-card sm:p-5"
        >
          <div className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br", c.tone.split(" text-")[0])} />
          <div className="relative">
            <span className={cn("inline-flex rounded-xl bg-surface p-2 shadow-sm", c.tone)}>{c.icon}</span>
            <p className="mt-4 text-3xl font-bold tracking-tight tabular-nums">{c.value}</p>
            <p className="mt-0.5 text-sm font-semibold">{c.label}</p>
            <p className="mt-1 text-xs text-muted">{c.hint}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ── Agenda ───────────────────────────────────────────────── */

async function Agenda({ view }: { view: AgendaView }) {
  const items = await getAgenda(view);

  if (items.length === 0) {
    const copy = {
      upcoming: { title: "No hay turnos próximos", text: "Crea el primero con «Nuevo turno» y mira cómo se programan los recordatorios." },
      past: { title: "Todavía no hay turnos pasados", text: "Aquí verás el historial de turnos atendidos y ausencias." },
      cancelled: { title: "Sin cancelaciones", text: "Los turnos cancelados (por ti o por el cliente) aparecen aquí." },
    }[view];
    return (
      <div className="animate-rise flex flex-col items-center rounded-3xl border border-dashed border-border bg-surface/50 px-6 py-16 text-center">
        <span className="rounded-2xl bg-brand-soft p-4 text-brand">
          <CalendarDays className="size-7" />
        </span>
        <p className="mt-4 font-semibold">{copy.title}</p>
        <p className="mt-1 max-w-sm text-sm text-muted">{copy.text}</p>
      </div>
    );
  }

  // Agrupar por día en la zona horaria de cada negocio.
  const groups = new Map<string, { label: string; items: AgendaItem[] }>();
  for (const item of items) {
    const tz = item.business.timezone;
    const start = new Date(item.starts_at);
    const key = dayKey(start, tz);
    if (!groups.has(key)) groups.set(key, { label: relativeDayLabel(start, tz), items: [] });
    groups.get(key)!.items.push(item);
  }

  return (
    <div className="space-y-8">
      {[...groups.entries()].map(([key, group]) => (
        <section key={key} aria-label={group.label}>
          <h3 className="mb-3 flex items-center gap-3 text-sm font-semibold">
            <span>{capitalizeFirst(group.label)}</span>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted tabular-nums">{group.items.length}</span>
            <span className="h-px flex-1 bg-border" />
          </h3>
          <ul className="space-y-3">
            {group.items.map((item, i) => (
              <AppointmentCard key={item.id} item={item} index={i} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AppointmentCard({ item, index }: { item: AgendaItem; index: number }) {
  const tz = item.business.timezone;
  const start = new Date(item.starts_at);
  const reminders = ["reminder_24h", "reminder_2h"]
    .map((kind) => item.messages.filter((m) => m.kind === kind).at(-1))
    .filter(Boolean);
  const muted = item.status === "cancelled";

  return (
    <li
      style={{ animationDelay: `${Math.min(index, 6) * 40}ms` }}
      className="animate-rise group relative flex items-center gap-4 rounded-3xl border border-border bg-surface p-3 pr-2 shadow-card transition hover:border-brand/40 has-[[aria-expanded=true]]:z-20 sm:p-4"
    >
      {/* Hora */}
      <div
        className={cn(
          "flex w-16 shrink-0 flex-col items-center justify-center rounded-2xl py-3 sm:w-20",
          muted ? "bg-surface-2 text-muted" : "bg-brand-soft text-brand-strong dark:text-brand",
        )}
      >
        <span className={cn("text-lg font-bold tabular-nums sm:text-xl", muted && "line-through")}>{formatHora(start, tz)}</span>
      </div>

      {/* Cliente */}
      <div className="min-w-0 flex-1">
        <Link
          href={`/panel/turnos/${item.id}`}
          className="flex items-center gap-2 font-semibold outline-none after:absolute after:inset-0 after:rounded-3xl hover:text-brand"
        >
          <span
            aria-hidden
            className="hidden size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[11px] font-bold text-muted sm:flex"
          >
            {initials(item.customer.name)}
          </span>
          <span className="truncate">{item.customer.name}</span>
        </Link>
        <p className="mt-0.5 truncate text-sm text-muted">
          {item.service ?? "Turno"} · {formatPhone(item.customer.phone)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge status={item.status} />
          {reminders.map((m) => (
            <span
              key={m!.kind}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted"
              title={m!.kind === "reminder_24h" ? "Recordatorio 24 h antes" : "Recordatorio 2 h antes"}
            >
              {m!.kind === "reminder_24h" ? "24 h" : "2 h"}
              <MessageTicks status={m!.status} />
            </span>
          ))}
        </div>
      </div>

      {/* Acciones (por encima del enlace que cubre la tarjeta) */}
      <div className="relative z-10 flex items-center">
        <AppointmentActions
          id={item.id}
          status={item.status}
          startsAt={item.starts_at}
          timeZone={tz}
          customerName={item.customer.name}
        />
        <ChevronRight className="hidden size-5 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand sm:block" />
      </div>
    </li>
  );
}

/* ── Actividad ────────────────────────────────────────────── */

async function Activity() {
  const items = await getRecentActivity();
  if (items.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-border p-6 text-center text-sm text-muted">
        Cuando un cliente responda a un recordatorio, lo verás aquí en tiempo real.
      </div>
    );
  }

  return (
    <ol className="space-y-1 rounded-3xl border border-border bg-surface p-2 shadow-card">
      {items.map((a) => {
        const tone =
          a.type === "failed"
            ? "bg-rose-500/10 text-rose-600"
            : a.intent === "confirm"
              ? "bg-emerald-500/10 text-emerald-600"
              : a.intent === "cancel"
                ? "bg-rose-500/10 text-rose-600"
                : "bg-sky-500/10 text-sky-600";
        const content = (
          <>
            <span className={cn("mt-0.5 rounded-xl p-2", tone)}>
              {a.type === "failed" ? <TriangleAlert className="size-4" /> : <MessageCircleReply className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm">
                <b className="font-semibold">{a.customerName ?? "Cliente"}</b>{" "}
                <span className="text-muted">
                  {a.type === "failed" ? "— envío fallido" : (INTENT_LABEL[a.intent ?? "unknown"] ?? "Escribió").toLowerCase()}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-sm text-muted">“{a.text}”</span>
            </span>
            <time dateTime={a.at} className="shrink-0 text-xs text-muted">
              {timeAgo(new Date(a.at))}
            </time>
          </>
        );
        return (
          <li key={a.id}>
            {a.appointmentId ? (
              <Link href={`/panel/turnos/${a.appointmentId}`} className="flex items-start gap-3 rounded-2xl p-3 transition hover:bg-surface-2">
                {content}
              </Link>
            ) : (
              <div className="flex items-start gap-3 rounded-2xl p-3">{content}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ── Skeletons ────────────────────────────────────────────── */

const pulse = "animate-pulse rounded-2xl bg-surface-2";

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className={cn(pulse, "h-40 rounded-3xl")} />
      ))}
    </div>
  );
}

function AgendaSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className={cn(pulse, "h-24 rounded-3xl")} />
      ))}
    </div>
  );
}

function ActivitySkeleton() {
  return <div className={cn(pulse, "h-72 rounded-3xl")} />;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <div className={cn(pulse, "h-4 w-24")} />
          <div className={cn(pulse, "h-9 w-40")} />
        </div>
        <div className={cn(pulse, "h-10 w-36")} />
      </div>
      <StatsSkeleton />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <AgendaSkeleton />
        <ActivitySkeleton />
      </div>
    </div>
  );
}
