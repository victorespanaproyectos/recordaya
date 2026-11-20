import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { can } from "@/lib/auth/permissions";
import { requireMember } from "@/lib/auth/session";
import { CATEGORIES, listSources, SOURCE_TYPES, type KnowledgeStatus, type SourceType } from "@/lib/chatbot/rag/sources";
import { timeAgo } from "@/lib/dates";
import { buttonStyles, cn, inputStyles } from "@/lib/panel/ui";
import { AutoRefresh } from "./auto-refresh";
import { CATEGORY_LABEL, errorMessage, STATUS_LABEL, TYPE_LABEL } from "./labels";
import { SourceActions } from "./source-actions";
import { AddSourceButton } from "./source-form";
import { UnansweredList } from "./unanswered-list";
import { listUnansweredGroups } from "@/lib/chatbot/unanswered";

export const metadata: Metadata = { title: "Conocimiento · RecordaYa" };

export default function KnowledgePage({ searchParams }: PageProps<"/panel/conocimiento">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <KnowledgeList searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

async function KnowledgeList({ searchParams }: { searchParams: PageProps<"/panel/conocimiento">["searchParams"] }) {
  const member = await requireMember("operator");
  const params = await searchParams;
  const type = (SOURCE_TYPES as readonly string[]).includes(one(params.tipo)) ? (one(params.tipo) as SourceType) : undefined;
  const category = (CATEGORIES as readonly string[]).includes(one(params.categoria)) ? (one(params.categoria) as (typeof CATEGORIES)[number]) : undefined;
  const status = Object.keys(STATUS_LABEL).includes(one(params.estado)) ? (one(params.estado) as KnowledgeStatus) : undefined;
  const q = one(params.q).slice(0, 100);

  const [sources, unansweredGroups] = await Promise.all([listSources(member.businessId, { type, category, status, q }), listUnansweredGroups(member.businessId)]);
  const canWrite = can(member.role, "knowledge.write");
  const busy = sources.some((s) => s.status === "pending" || s.status === "processing");

  return (
    <div className="space-y-6">
      <AutoRefresh active={busy} />
      <div className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Conocimiento</h1>
          <p className="mt-1 text-muted">Lo que el asistente sabe de tu negocio. {canWrite ? "" : "Solo lectura para tu rol."}</p>
        </div>
        {canWrite && <AddSourceButton />}
      </div>

      <form className="flex flex-wrap gap-2" role="search">
        <input name="q" defaultValue={q} placeholder="Buscar por título" aria-label="Buscar por título" className={cn(inputStyles, "w-56")} />
        <Select name="tipo" label="Tipo" value={type} options={TYPE_LABEL} />
        <Select name="categoria" label="Categoría" value={category} options={CATEGORY_LABEL} />
        <Select name="estado" label="Estado" value={status} options={Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, v]) => [k, v.label]))} />
        <button type="submit" className={buttonStyles.secondary}>
          Filtrar
        </button>
      </form>

      {sources.length === 0 ? (
        <p className="rounded-2xl border border-border p-8 text-center text-muted">
          {type || category || status || q ? "Ninguna fuente coincide con el filtro." : "Todavía no hay conocimiento cargado."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs tracking-wider text-muted uppercase">
              <tr>
                <th className="px-4 py-3">Título</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Categoría</th>
                <th className="px-4 py-3">Estado</th>
                <th className="px-4 py-3 text-right">Fragmentos</th>
                <th className="px-4 py-3">Actualizado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sources.map((s) => {
                const st = STATUS_LABEL[s.status];
                const error = errorMessage(s.lastError);
                return (
                  <tr key={s.id}>
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/panel/conocimiento/${s.id}`} className="inline-flex items-center gap-1 hover:underline">
                        {s.title}
                        <ChevronRight className="size-3.5 text-muted" />
                      </Link>
                      {error && <p className="mt-0.5 text-xs font-normal text-rose-600 dark:text-rose-300">{error}</p>}
                    </td>
                    <td className="px-4 py-3">{TYPE_LABEL[s.type]}</td>
                    <td className="px-4 py-3">{CATEGORY_LABEL[s.category]}</td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-medium", st.className)}>{st.label}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{s.chunkCount}</td>
                    <td className="px-4 py-3 text-muted">{timeAgo(new Date(s.updatedAt))}</td>
                    <td className="px-4 py-3">{canWrite && <SourceActions source={s} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="space-y-3 pt-4" aria-labelledby="unanswered-title">
        <div>
          <h2 id="unanswered-title" className="text-xl font-semibold">
            Preguntas sin respuesta
          </h2>
          <p className="text-sm text-muted">Lo que los clientes preguntaron y el asistente no pudo contestar. Agrega la respuesta y la próxima vez lo sabrá.</p>
        </div>
        <UnansweredList groups={unansweredGroups.map((g) => ({ question: g.question, ids: g.ids, count: g.count, reasons: g.reasons }))} canResolve={can(member.role, "unanswered.resolve")} />
      </section>
    </div>
  );
}

function Select({ name, label, value, options }: { name: string; label: string; value?: string; options: Record<string, string> }) {
  return (
    <select name={name} defaultValue={value ?? ""} aria-label={label} className={cn(inputStyles, "w-auto")}>
      <option value="">{label}: todos</option>
      {Object.entries(options).map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}
