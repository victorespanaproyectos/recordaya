"use client";

import { Bot, BookOpen, CalendarDays, MessagesSquare, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useToast } from "@/components/toaster";
import { can, type Role } from "@/lib/auth/permissions";
import { cn } from "@/lib/panel/ui";
import { setMyAvailabilityAction } from "./equipo/actions";

interface Counters {
  pending: number;
  mine: number;
  mineUnread: number;
  available: boolean | null;
}

const POLL_MS = 5000;

/** Navegación del panel: ítems según el rol, contador de conversaciones por polling e interruptor «Disponible». */
export function PanelNav({ role, isMember }: { role: Role; isMember: boolean }) {
  const pathname = usePathname();
  const toast = useToast();
  const [counters, setCounters] = useState<Counters>({ pending: 0, mine: 0, mineUnread: 0, available: null });
  const [pending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/panel/inbox", { cache: "no-store" });
      if (res.ok) setCounters(await res.json());
    } catch {
      /* sin red: se reintenta en el próximo ciclo */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0); // primera lectura sin bloquear el render
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const badge = counters.pending + counters.mineUnread;
  const items = [
    { href: "/panel", label: "Agenda", icon: CalendarDays, show: can(role, "agenda.view"), exact: true },
    { href: "/panel/conversaciones", label: "Conversaciones", icon: MessagesSquare, show: can(role, "inbox.view"), badge },
    { href: "/panel/conocimiento", label: "Conocimiento", icon: BookOpen, show: can(role, "knowledge.view") },
    { href: "/panel/chatbot", label: "Chatbot", icon: Bot, show: can(role, "chatbot.configure") },
    { href: "/panel/equipo", label: "Equipo", icon: Users, show: can(role, "members.manage") },
  ].filter((i) => i.show);

  return (
    <>
      <nav className="flex items-center gap-1 overflow-x-auto" aria-label="Secciones del panel">
        {items.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn("inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold whitespace-nowrap transition", active ? "bg-surface-2" : "text-muted hover:bg-surface-2 hover:text-fg")}
            >
              <item.icon className={cn("size-4", active && "text-brand")} />
              <span className="hidden md:inline">{item.label}</span>
              {item.badge ? (
                <span className="min-w-5 rounded-full bg-brand px-1.5 text-center text-xs font-bold text-brand-fg" aria-label={`${item.badge} pendientes`}>
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      {isMember && counters.available !== null && (
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            role="switch"
            checked={counters.available}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              setCounters((c) => ({ ...c, available: next }));
              startTransition(async () => {
                const result = await setMyAvailabilityAction(next);
                if (!result.ok) {
                  setCounters((c) => ({ ...c, available: !next }));
                  toast({ kind: "error", title: "No se pudo cambiar", description: result.error });
                }
              });
            }}
            className="size-4"
          />
          Disponible
        </label>
      )}
    </>
  );
}
