import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { SetPasswordForm } from "./set-password-form";

export const metadata: Metadata = {
  title: "Definir contraseña · RecordaYa",
};

export default function SetPasswordPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12 sm:px-8">
      <div className="animate-rise w-full max-w-sm">
        <Link href="/" className="mb-10 inline-block">
          <Logo />
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Define tu contraseña</h1>
        <p className="mt-1.5 mb-8 text-muted">Con ella entrarás al panel de tu equipo.</p>
        <SetPasswordForm />
      </div>
    </main>
  );
}
