import type { Metadata } from "next";
import { Suspense } from "react";
import { listMembers } from "@/lib/auth/members";
import { requireMember } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cn } from "@/lib/panel/ui";
import { EditMemberButton, InviteMemberButton, ROLE_LABEL } from "./member-form";

export const metadata: Metadata = { title: "Equipo · RecordaYa" };

const STATUS: Record<string, { label: string; className: string }> = {
  active: { label: "Activo", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  invited: { label: "Invitación pendiente", className: "bg-amber-500/10 text-amber-700 dark:text-amber-300" },
  disabled: { label: "Desactivado", className: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
};

export default function TeamPage() {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <Team />
    </Suspense>
  );
}

async function Team() {
  const member = await requireMember("admin");
  const [members, { data: active }] = await Promise.all([
    listMembers(member),
    getSupabaseAdmin().from("conversations").select("assigned_member_id").eq("business_id", member.businessId).eq("status", "human"),
  ]);
  const load = new Map<string, number>();
  for (const c of active ?? []) if (c.assigned_member_id) load.set(c.assigned_member_id, (load.get(c.assigned_member_id) ?? 0) + 1);

  return (
    <div className="space-y-6">
      <div className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Equipo</h1>
          <p className="mt-1 text-muted">Quién puede entrar al panel y qué puede hacer. Siempre debe quedar al menos un owner activo.</p>
        </div>
        <InviteMemberButton actorRole={member.role} />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs tracking-wider text-muted uppercase">
            <tr>
              <th className="px-4 py-3">Nombre</th>
              <th className="px-4 py-3">Rol</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Disponible</th>
              <th className="px-4 py-3 text-right">Conversaciones</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((m) => {
              const st = STATUS[m.status];
              return (
                <tr key={m.id}>
                  <td className="px-4 py-3">
                    <span className="font-medium">{m.displayName}</span>
                    <span className="block text-xs text-muted">{m.email}</span>
                  </td>
                  <td className="px-4 py-3">{ROLE_LABEL[m.role]}</td>
                  <td className="px-4 py-3">
                    <span className={cn("inline-flex rounded-full px-2.5 py-1 text-xs font-medium", st.className)}>{st.label}</span>
                  </td>
                  <td className="px-4 py-3">{m.status === "active" ? (m.isAvailable ? "Sí" : "No") : "—"}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {load.get(m.id) ?? 0} / {m.maxConcurrent}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <EditMemberButton member={{ id: m.id, displayName: m.displayName, email: m.email, role: m.role, status: m.status, maxConcurrent: m.maxConcurrent }} actorRole={member.role} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
