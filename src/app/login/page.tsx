import { CheckCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Entrar · RecordaYa",
};

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      {/* Lado de marca */}
      <section className="relative hidden overflow-hidden bg-[#06281f] p-12 text-white lg:flex lg:flex-col">
        <div
          aria-hidden
          className="absolute inset-0 opacity-90"
          style={{
            background:
              "radial-gradient(60% 50% at 20% 10%, rgb(34 200 150 / 0.35), transparent 70%), radial-gradient(50% 60% at 90% 90%, rgb(14 159 119 / 0.45), transparent 70%)",
          }}
        />
        <div className="relative">
          <Link href="/" className="[--brand-fg:#06281f] [--brand:#22c896]">
            <Logo className="text-white" />
          </Link>
        </div>

        <div className="relative my-auto max-w-md">
          <h1 className="text-4xl leading-tight font-bold tracking-tight">
            Menos ausencias.
            <br />
            <span className="text-[#5ee6b8]">Más turnos cumplidos.</span>
          </h1>
          <p className="mt-4 text-lg text-white/70">
            Recordatorios automáticos por WhatsApp 24 h y 2 h antes de cada turno, con confirmación en
            un toque.
          </p>

          {/* Vista previa del chat */}
          <div className="mt-10 space-y-3 rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur-sm">
            <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-[#0d1a16] shadow-lg">
              Hola Victor, te recordamos tu turno del <b>lunes 17</b> a las <b>15:30</b> en Barber Demo.
              Respondé <b>1</b> para confirmar o <b>2</b> para cancelar.
              <span className="mt-1 flex justify-end text-[11px] text-slate-400">10:02</span>
            </div>
            <div className="ml-auto w-fit rounded-2xl rounded-tr-md bg-[#d9fdd3] px-4 py-2.5 text-sm text-[#0d1a16] shadow-lg">
              1
              <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-500">
                10:04 <CheckCheck className="size-3.5 text-sky-500" />
              </span>
            </div>
            <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white px-4 py-3 text-sm text-[#0d1a16] shadow-lg">
              ¡Gracias, Victor! Tu turno quedó confirmado. ✅
            </div>
          </div>
        </div>

        <p className="relative text-sm text-white/50">Proyecto demo · WhatsApp Cloud API</p>
      </section>

      {/* Formulario */}
      <section className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="animate-rise w-full max-w-sm">
          <Link href="/" className="mb-10 inline-block lg:hidden">
            <Logo />
          </Link>
          <h2 className="text-2xl font-bold tracking-tight">Bienvenido de vuelta</h2>
          <p className="mt-1.5 mb-8 text-muted">Entra para gestionar los turnos y recordatorios.</p>
          <Suspense>
            <LoginForm />
          </Suspense>
          <p className="mt-8 text-center text-xs text-muted">
            ¿Viste esta demo en un portfolio? Pide la contraseña al autor.
          </p>
        </div>
      </section>
    </main>
  );
}
