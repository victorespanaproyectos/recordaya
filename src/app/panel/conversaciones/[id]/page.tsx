import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { can } from "@/lib/auth/permissions";
import { requireMember } from "@/lib/auth/session";
import { getConversationDetail, listActiveMembers } from "@/lib/chatbot/panel-data";
import { getBusinesses } from "@/lib/panel/data";
import { cn } from "@/lib/panel/ui";
import { reopenTemplateName } from "@/lib/whatsapp/templates";
import { AutoRefresh } from "../../conocimiento/auto-refresh";
import { CONVERSATION_STATUS, HANDOFF_REASON } from "../labels";
import { ActionsBar } from "./actions-bar";
import { Composer } from "./composer";
import { ContactPanel } from "./contact-panel";
import { EraseContact } from "./erase-contact";
import { ConversationTimeline } from "./conversation-timeline";

export const metadata: Metadata = { title: "Conversación · RecordaYa" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ConversationPage({ params }: PageProps<"/panel/conversaciones/[id]">) {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <Detail params={params} />
    </Suspense>
  );
}

async function Detail({ params }: { params: PageProps<"/panel/conversaciones/[id]">["params"] }) {
  const member = await requireMember("operator");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const detail = await getConversationDetail(member.businessId, id);
  if (!detail) notFound();
  const [[business], members] = await Promise.all([getBusinesses(member.businessId), listActiveMembers(member.businessId)]);

  const { conversation: c, contact } = detail;
  const st = CONVERSATION_STATUS[c.status];
  const isAssignee = !!member.id && c.assignedTo?.id === member.id;
  const isAdmin = can(member.role, "conversation.reassign_or_close_any");
  const canWrite = c.status === "human" && isAssignee;
  const reason = c.status === "closed" ? "Conversación cerrada: solo lectura." : c.status === "human" ? `La atiende ${c.assignedTo?.name ?? "otra persona"}.` : "Tómala para poder responder.";

  return (
    <div className="space-y-6">
      <AutoRefresh active />
      <div className="animate-rise space-y-3">
        <Link href="/panel/conversaciones" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" />
          Conversaciones
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{contact.name ?? contact.phone}</h1>
          <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset", st.className)}>{st.label}</span>
          {c.assignedTo && <span className="text-sm text-muted">Asignada a {c.assignedTo.name}</span>}
        </div>
        <ActionsBar id={c.id} version={c.version} status={c.status} isAdmin={isAdmin} isMember={!member.legacy} isAssignee={isAssignee} members={members} assignedId={c.assignedTo?.id ?? null} />
        {c.handoffReason && (c.status === "pending_human" || c.status === "human") && (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">Derivada porque: {HANDOFF_REASON[c.handoffReason] ?? c.handoffReason}.</p>
        )}
        {c.summary && (
          <details className="rounded-xl border border-border p-3 text-sm" open={c.status === "pending_human"}>
            <summary className="cursor-pointer font-medium">Resumen para quien atiende</summary>
            <p className="mt-2 whitespace-pre-wrap text-muted">{c.summary}</p>
          </details>
        )}
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {detail.timeline.length === 0 ? <p className="text-sm text-muted">Todavía no hay mensajes.</p> : <ConversationTimeline entries={detail.timeline} timeZone={business?.timezone ?? "America/Montevideo"} />}
          <div className="sticky bottom-0 bg-bg pt-3">
            <Composer id={c.id} enabled={canWrite} reason={reason} windowClosesAt={detail.windowClosesAt} hasTemplate={reopenTemplateName() !== null} />
          </div>
        </div>
        <div className="space-y-5">
          <ContactPanel detail={detail} />
          {can(member.role, "contact.erase") && <EraseContact id={c.id} />}
        </div>
      </div>
    </div>
  );
}
