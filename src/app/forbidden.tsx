import Link from "next/link";
import { Logo } from "@/components/logo";

export default function Forbidden() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12 sm:px-8">
      <div className="animate-rise w-full max-w-sm">
        <Link href="/" className="mb-10 inline-block">
          <Logo />
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Sin acceso</h1>
        <p className="mt-1.5 mb-8 text-muted">
          Tu usuario no tiene permiso para ver esta página. Si crees que es un error, pide acceso a quien administra tu negocio.
        </p>
        <Link href="/login" className="text-sm font-medium text-brand hover:underline">
          Volver a entrar
        </Link>
      </div>
    </main>
  );
}
