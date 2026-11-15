import { CalendarDays, LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { ToastProvider } from "@/components/toaster";
import { buttonStyles } from "@/lib/panel/ui";
import { logoutAction } from "../login/actions";

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-dvh">
        <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6">
            <Link href="/panel" aria-label="RecordaYa, ir a la agenda">
              <Logo />
            </Link>
            <nav className="hidden items-center gap-1 sm:flex">
              <Link
                href="/panel"
                className="inline-flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-sm font-semibold"
              >
                <CalendarDays className="size-4 text-brand" />
                Agenda
              </Link>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted md:inline">
                Modo demo
              </span>
              <form action={logoutAction}>
                <button type="submit" className={buttonStyles.ghost} aria-label="Salir del panel">
                  <LogOut className="size-4" />
                  <span className="hidden sm:inline">Salir</span>
                </button>
              </form>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6">{children}</main>
      </div>
    </ToastProvider>
  );
}
