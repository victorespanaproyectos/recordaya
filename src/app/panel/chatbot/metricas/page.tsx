import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { can } from "@/lib/auth/permissions";
import { requireMember } from "@/lib/auth/session";
import { getMetrics } from "@/lib/chatbot/panel-data";
import { getBusinesses } from "@/lib/panel/data";
import { cn } from "@/lib/panel/ui";

export const metadata: Metadata = { title: "Métricas del chatbot · RecordaYa" };

export default function MetricsPage({ searchParams }: PageProps<"/panel/chatbot/metricas">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <Metrics searchParams={searchParams} />
    </Suspense>
  );
}

/** "45 s", "3 min", "2 h 10 min". */
function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const usd = (n: number) => `US$ ${n.toFixed(n < 1 ? 4 : 2)}`;

async function Metrics({ searchParams }: { searchParams: PageProps<"/panel/chatbot/metricas">["searchParams"] }) {
  const member = await requireMember("operator");
  const params = await searchParams;
  const days = (Array.isArray(params.dias) ? params.dias[0] : params.dias) === "30" ? 30 : 7;
  const [business] = await getBusinesses(member.businessId);
  const m = await getMetrics(member.businessId, days, business?.timezone ?? "America/Montevideo", can(member.role, "usage_costs.view"));
  const max = Math.max(1, ...m.daily.map((d) => d.ai + d.handedOff));

  return (
    <div className="space-y-8">
      <div className="animate-rise space-y-2">
        <Link href="/panel/chatbot" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" />
          Chatbot
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Métricas</h1>
          <div className="flex gap-1" role="group" aria-label="Período">
            {[7, 30].map((d) => (
              <Link key={d} href={`/panel/chatbot/metricas?dias=${d}`} aria-current={days === d ? "page" : undefined} className={cn("rounded-xl px-3 py-1.5 text-sm font-medium", days === d ? "bg-surface-2" : "text-muted hover:bg-surface-2")}>
                {d} días
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Conversaciones" value={String(m.conversations)} />
        <Card label="Resueltas por la IA" value={m.resolvedByAiPct === null ? "—" : `${m.resolvedByAiPct} %`} hint="sin pasar por una persona" />
        <Card label="Derivadas" value={m.handedOffPct === null ? "—" : `${m.handedOffPct} %`} hint="pasaron a una persona" />
        <Card label="Pendientes ahora" value={String(m.pendingNow)} hint="esperando a una persona" />
        <Card label="Sin respuesta (abiertas)" value={String(m.unansweredOpen)} hint="preguntas que el asistente no pudo responder" />
        <Card label="1.ª respuesta de la IA" value={duration(m.firstAiResponseSec)} hint="mediana" />
        <Card label="1.ª respuesta humana" value={duration(m.firstHumanResponseSec)} hint="mediana desde la derivación" />
        {m.costs && <Card label="Costo del mes" value={usd(m.costs.monthCostUsd)} hint={`tope ${usd(m.costs.monthlyBudgetUsd)}`} />}
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Conversaciones por día</h2>
        <div className="flex items-end gap-1 rounded-2xl border border-border p-4" role="img" aria-label={`Conversaciones nuevas por día: ${m.daily.map((d) => `${d.day}: ${d.ai} con IA y ${d.handedOff} derivadas`).join("; ")}`}>
          {m.daily.map((d) => (
            <div key={d.day} className="flex h-40 min-w-0 flex-1 flex-col justify-end gap-px" title={`${d.day}: ${d.ai} IA · ${d.handedOff} derivadas`}>
              <div className="rounded-t bg-rose-500/60" style={{ height: `${(d.handedOff / max) * 100}%` }} />
              <div className="bg-sky-500/70" style={{ height: `${(d.ai / max) * 100}%` }} />
            </div>
          ))}
        </div>
        <p className="flex gap-4 text-xs text-muted">
          <span>
            <span className="mr-1 inline-block size-2 rounded-sm bg-sky-500/70" />
            IA
          </span>
          <span>
            <span className="mr-1 inline-block size-2 rounded-sm bg-rose-500/60" />
            Derivadas
          </span>
        </p>
      </section>

      {m.costs && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Consumo ({days} días)</h2>
          {m.costs.byOperation.length === 0 ? (
            <p className="text-sm text-muted">Sin consumo en el período.</p>
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-2 text-left text-xs tracking-wider text-muted uppercase">
                  <tr>
                    <Th>Operación</Th>
                    <Th>Modelo</Th>
                    <Th right>Llamadas</Th>
                    <Th right>Tokens entrada</Th>
                    <Th right>Tokens salida</Th>
                    <Th right>Costo estimado</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {m.costs.byOperation.map((r) => (
                    <tr key={`${r.operation}-${r.model}`}>
                      <td className="px-4 py-2">{r.operation}</td>
                      <td className="px-4 py-2">{r.model}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.calls}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.inputTokens.toLocaleString("es-UY")}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{r.outputTokens.toLocaleString("es-UY")}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{usd(r.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border p-4">
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={cn("px-4 py-2", right && "text-right")}>{children}</th>;
}
