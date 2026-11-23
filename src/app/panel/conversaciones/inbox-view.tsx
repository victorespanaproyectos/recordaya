import Link from "next/link";
import { requireMember } from "@/lib/auth/session";
import { getInboxCounts, INBOX_TABS, listActiveMembers, listInbox, type InboxTab } from "@/lib/chatbot/panel-data";
import { timeAgo } from "@/lib/dates";
import { getBusinesses } from "@/lib/panel/data";
import { buttonStyles, cn, formatPhone, initials, inputStyles } from "@/lib/panel/ui";
import { AutoRefresh } from "../conocimiento/auto-refresh";
import { CONVERSATION_STATUS, HANDOFF_REASON, TABS } from "./labels";

type SearchParams = Record<string, string | string[] | undefined>;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const EMPTY: Record<InboxTab, string> = {
  pending: "No hay conversaciones esperando a una persona 🎉",
  mine: "No tienes conversaciones asignadas. Toma una de la pestaña «Pendientes».",
  ai: "El asistente no está atendiendo ninguna conversación ahora.",
  all: "Todavía no hay conversaciones.",
  closed: "No hay conversaciones cerradas.",
};

/**
 * Bandeja de conversaciones. Sola ocupa toda la página; con `selectedId` es la columna izquierda
 * (lista de 360 px) junto al detalle, como pide 06 §18.2 (dos columnas en escritorio).
 */
export async function InboxView({ searchParams, selectedId }: { searchParams: Promise<SearchParams>; selectedId?: string }) {
  const compact = selectedId !== undefined;
  const member = await requireMember("operator");
  const params = await searchParams;
  const tab = (INBOX_TABS as string[]).includes(one(params.tab)) ? (one(params.tab) as InboxTab) : "pending";
  const channel = one(params.canal) === "whatsapp" || one(params.canal) === "web" ? (one(params.canal) as "whatsapp" | "web") : undefined;
  const q = one(params.q).slice(0, 80);
  const operatorId = /^[0-9a-f-]{36}$/i.test(one(params.operador)) ? one(params.operador) : undefined;
  const date = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const from = date(one(params.desde));
  const to = date(one(params.hasta));
  const cursor = one(params.cursor) || undefined;

  const [business] = await getBusinesses(member.businessId);
  const [counts, page, members] = await Promise.all([
    getInboxCounts(member.businessId, member),
    listInbox(member.businessId, member, { tab, q, channel, operatorId, from, to, cursor }, business?.timezone),
    listActiveMembers(member.businessId),
  ]);

  const basePath = compact ? `/panel/conversaciones/${selectedId}` : "/panel/conversaciones";
  const filters = (over: Record<string, string | undefined> = {}) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries({ tab, q, canal: channel, operador: operatorId, desde: from, hasta: to, ...over })) if (v) sp.set(k, v);
    return sp.toString();
  };
  const query = (over: Record<string, string | undefined>) => `${basePath}?${filters(over)}`;
  // Al abrir una conversación se conservan la pestaña y los filtros, para que la lista no cambie.
  const rowHref = (id: string) => `/panel/conversaciones/${id}?${filters({ cursor: undefined })}`;

  return (
    <div className="space-y-6">
      <AutoRefresh active={!cursor && !compact} everyMs={5000} />
      {!compact && (
        <div className="animate-rise">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Conversaciones</h1>
          <p className="mt-1 text-muted">Lo que escriben tus clientes: lo atiende el asistente o lo toma una persona del equipo.</p>
        </div>
      )}

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={query({ tab: t.id, cursor: undefined })}
            role="tab"
            aria-selected={tab === t.id}
            className={cn("-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium", tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}
          >
            {t.label}
            <span className="rounded-full bg-surface-2 px-2 text-xs tabular-nums">{counts[t.id]}</span>
          </Link>
        ))}
      </div>

      <form className="flex flex-wrap gap-2" role="search" action={basePath}>
        <input type="hidden" name="tab" value={tab} />
        <input name="q" defaultValue={q} placeholder="Buscar por nombre, teléfono o texto" aria-label="Buscar" className={cn(inputStyles, compact ? "w-full" : "w-72")} />
        <select name="canal" defaultValue={channel ?? ""} aria-label="Canal" className={cn(inputStyles, "w-auto")}>
          <option value="">Canal: todos</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="web">Web</option>
        </select>
        <select name="operador" defaultValue={operatorId ?? ""} aria-label="Operador" className={cn(inputStyles, "w-auto")}>
          <option value="">Operador: todos</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input type="date" name="desde" defaultValue={from} aria-label="Desde" className={cn(inputStyles, "w-auto")} />
        <input type="date" name="hasta" defaultValue={to} aria-label="Hasta" className={cn(inputStyles, "w-auto")} />
        <button type="submit" className={buttonStyles.secondary}>
          Filtrar
        </button>
      </form>

      {page.items.length === 0 ? (
        <p className="rounded-2xl border border-border p-8 text-center text-muted">{q || channel || operatorId || from || to ? "Ninguna conversación coincide con el filtro." : EMPTY[tab]}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border">
          {page.items.map((c) => {
            const st = CONVERSATION_STATUS[c.status];
            return (
              <li key={c.id}>
                <Link
                  href={rowHref(c.id)}
                  aria-current={c.id === selectedId ? "page" : undefined}
                  className={cn("flex items-start gap-3 px-4 py-3 transition hover:bg-surface-2", c.id === selectedId && "bg-surface-2")}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-sm font-bold text-brand">{initials(c.contactName ?? c.phone)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{c.contactName ?? formatPhone(c.phone)}</span>
                      <span className="text-xs text-muted">{c.contactName ? formatPhone(c.phone) : ""}</span>
                      <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset", st.className)}>{st.label}</span>
                      {c.assignedTo && <span className="text-xs text-muted">· {c.assignedTo.name}</span>}
                    </span>
                    <span className="mt-0.5 line-clamp-1 text-sm text-muted">
                      {c.previewFrom && c.previewFrom !== "customer" ? "Tú/asistente: " : ""}
                      {c.preview ?? "Sin mensajes"}
                    </span>
                    {c.status === "pending_human" && c.handoffReason && <span className="mt-0.5 block text-xs text-amber-700 dark:text-amber-300">{HANDOFF_REASON[c.handoffReason]}</span>}
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-muted">{timeAgo(new Date(c.lastMessageAt))}</span>
                    {c.unread > 0 && <span className="min-w-5 rounded-full bg-brand px-1.5 text-center text-xs font-bold text-brand-fg">{c.unread}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {page.nextCursor && (
        <div className="flex justify-center">
          <Link href={query({ cursor: page.nextCursor })} className={buttonStyles.secondary}>
            Ver más antiguas
          </Link>
        </div>
      )}
    </div>
  );
}
