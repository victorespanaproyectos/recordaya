import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ServiceError } from "@/lib/appointments/service";
import { requireMember } from "@/lib/auth/session";
import { getSource, getSourceContent } from "@/lib/chatbot/rag/sources";
import { timeAgo } from "@/lib/dates";
import { cn } from "@/lib/panel/ui";
import { AutoRefresh } from "../auto-refresh";
import { CATEGORY_LABEL, errorMessage, STATUS_LABEL, TYPE_LABEL } from "../labels";

export const metadata: Metadata = { title: "Fuente de conocimiento · RecordaYa" };

export default function SourcePage({ params }: PageProps<"/panel/conocimiento/[id]">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <SourceDetail params={params} />
    </Suspense>
  );
}

async function SourceDetail({ params }: { params: PageProps<"/panel/conocimiento/[id]">["params"] }) {
  const member = await requireMember("operator");
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  let data;
  try {
    data = { ...(await getSource(member.businessId, id)), content: await getSourceContent(member.businessId, id) };
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) notFound();
    throw error;
  }
  const { source, versions, content } = data;
  const st = STATUS_LABEL[source.status];
  const error = errorMessage(source.lastError);
  const busy = versions.some((v) => v.status === "pending" || v.status === "processing");

  return (
    <div className="space-y-8">
      <AutoRefresh active={busy} />
      <div className="animate-rise space-y-2">
        <Link href="/panel/conocimiento" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" />
          Conocimiento
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">{source.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {TYPE_LABEL[source.type]} · {CATEGORY_LABEL[source.category]} ·
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", st.className)}>{st.label}</span>
          · actualizado {timeAgo(new Date(source.updatedAt))}
        </p>
        {error && <p className="text-sm text-rose-600 dark:text-rose-300">{error}</p>}
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Contenido</h2>
        {source.type === "faq" && (
          <dl className="space-y-2 text-sm">
            <dt className="font-medium">Pregunta</dt>
            <dd className="text-muted">{source.faqQuestion}</dd>
            <dt className="font-medium">Respuesta</dt>
            <dd className="whitespace-pre-wrap text-muted">{source.faqAnswer}</dd>
          </dl>
        )}
        {source.type === "url" && <p className="text-sm break-all text-muted">{source.url}</p>}
        {source.type === "file" && <p className="text-sm text-muted break-all">Archivo guardado de forma privada: {source.storagePath?.split("/").pop()}</p>}
        {(source.type === "text" || content.extractedText) && (
          <div>
            <p className="mb-1 text-xs text-muted">
              Texto extraído{content.extractedChars ? ` (${content.extractedChars.toLocaleString("es-UY")} caracteres${content.extractedChars > 20_000 ? ", se muestran los primeros 20 000" : ""})` : ""}
            </p>
            <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-surface-2 p-4 text-xs whitespace-pre-wrap">{content.extractedText ?? source.body}</pre>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Historial de versiones</h2>
        <ul className="divide-y divide-border rounded-2xl border border-border text-sm">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span className="font-medium">Versión {v.version}</span>
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", STATUS_LABEL[v.status]?.className)}>{STATUS_LABEL[v.status]?.label}</span>
              {v.id === source.activeDocumentId && <span className="text-xs text-emerald-600 dark:text-emerald-300">En uso</span>}
              <span className="text-muted">{timeAgo(new Date(v.createdAt))}</span>
              {errorMessage(v.error) && <span className="w-full text-xs text-rose-600 dark:text-rose-300">{errorMessage(v.error)}</span>}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Fragmentos ({content.chunks.length})</h2>
        {content.chunks.length === 0 ? (
          <p className="text-sm text-muted">Todavía no hay fragmentos: la fuente se está procesando o tuvo un error.</p>
        ) : (
          <ol className="space-y-2">
            {content.chunks.map((c) => (
              <li key={c.index} className="rounded-xl border border-border p-3 text-sm">
                <p className="mb-1 text-xs text-muted">
                  #{c.index + 1} · ≈ {c.tokenEstimate} tokens
                </p>
                <p className="whitespace-pre-wrap">{c.content}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
