import { LogOut } from "lucide-react";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { Logo } from "@/components/logo";
import { ToastProvider } from "@/components/toaster";
import { getCurrentMember } from "@/lib/auth/session";
import { buttonStyles } from "@/lib/panel/ui";
import { logoutAction } from "../login/actions";
import { PanelNav } from "./nav";

/** La navegación depende de quién entró (rol, sesión de demostración), así que se resuelve por petición. */
async function Navigation() {
  const member = await getCurrentMember();
  if (!member) return null; // el proxy ya redirige a /login; esto solo evita mostrar menús sin sesión
  return (
    <>
      <PanelNav role={member.role} isMember={!member.legacy} />
      {member.legacy && (
        <span className="hidden rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted md:inline">Modo demo</span>
      )}
    </>
  );
}

export default function PanelLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <div className="min-h-dvh">
        <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-md">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:gap-6 sm:px-6">
            <Link href="/panel" aria-label="RecordaYa, ir a la agenda">
              <Logo />
            </Link>
            <Suspense fallback={<div className="flex-1" />}>
              <Navigation />
            </Suspense>
            <div className="ml-auto flex items-center gap-2">
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
