import {
  ArrowRight,
  BellRing,
  CalendarPlus,
  CheckCheck,
  Clock3,
  LayoutDashboard,
  MessageCircleReply,
  ShieldCheck,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonStyles, cn } from "@/lib/panel/ui";

const STEPS = [
  {
    icon: <CalendarPlus className="size-5" />,
    title: "Cargas el turno",
    text: "Nombre, WhatsApp y horario. El cliente recibe la confirmación al instante.",
  },
  {
    icon: <BellRing className="size-5" />,
    title: "Se recuerda solo",
    text: "24 h y 2 h antes sale un recordatorio automático, aunque cierres la app.",
  },
  {
    icon: <MessageCircleReply className="size-5" />,
    title: "El cliente responde",
    text: "Con un «1» confirma y con un «2» cancela. Tu agenda se actualiza sola.",
  },
];

const FEATURES = [
  { icon: <CheckCheck className="size-5" />, title: "Entregado y leído", text: "Ves el estado real de cada mensaje, como en WhatsApp." },
  { icon: <Zap className="size-5" />, title: "Envíos programados", text: "Colas con reintentos: ningún recordatorio se pierde." },
  { icon: <LayoutDashboard className="size-5" />, title: "Panel claro", text: "Agenda por día, métricas y actividad en un vistazo." },
  { icon: <ShieldCheck className="size-5" />, title: "API oficial", text: "WhatsApp Cloud API de Meta con webhooks firmados." },
];

const STACK = ["Next.js 16", "TypeScript", "Supabase", "WhatsApp Cloud API", "Upstash QStash", "Vercel"];

export default function Home() {
  return (
    <div className="relative overflow-hidden">
      {/* Fondo */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px]"
        style={{
          background:
            "radial-gradient(50% 60% at 15% 0%, rgb(34 200 150 / 0.18), transparent 70%), radial-gradient(40% 50% at 95% 20%, rgb(14 159 119 / 0.16), transparent 70%)",
        }}
      />

      <header className="relative mx-auto flex h-20 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <Link href="/panel" className={buttonStyles.secondary}>
          Abrir panel
        </Link>
      </header>

      <main className="relative">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-4 pt-10 pb-24 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:pt-16">
          <div className="animate-rise">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-semibold text-muted shadow-sm">
              <span className="size-2 animate-pulse rounded-full bg-brand" />
              Proyecto demo · funcionando en producción
            </span>
            <h1 className="mt-6 text-4xl leading-[1.05] font-extrabold tracking-tight text-balance sm:text-6xl">
              Que nadie se olvide <span className="text-brand">de su turno.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-pretty text-muted">
              RecordaYa envía confirmaciones y recordatorios por WhatsApp de forma automática, y deja que tus
              clientes confirmen o cancelen con un solo mensaje.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/panel" className={cn(buttonStyles.primary, "px-5 py-3 text-base")}>
                Probar el panel
                <ArrowRight className="size-4" />
              </Link>
              <a href="#como-funciona" className={cn(buttonStyles.secondary, "px-5 py-3 text-base")}>
                Cómo funciona
              </a>
            </div>
            <ul className="mt-10 flex flex-wrap gap-2" aria-label="Tecnologías">
              {STACK.map((s) => (
                <li key={s} className="rounded-lg bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted">
                  {s}
                </li>
              ))}
            </ul>
          </div>

          {/* Teléfono */}
          <div className="animate-rise relative mx-auto w-full max-w-[340px]" style={{ animationDelay: "120ms" }}>
            <div className="absolute -inset-6 -z-10 rounded-[3rem] bg-brand/20 blur-3xl" aria-hidden />
            <div className="rounded-[2.5rem] border-[10px] border-[#101a17] bg-[#efeae2] shadow-2xl dark:bg-[#0b141a]">
              <div className="flex items-center gap-3 rounded-t-[1.8rem] bg-[#075e54] px-4 py-3 text-white">
                <span className="flex size-9 items-center justify-center rounded-full bg-white/15 text-sm font-bold">BD</span>
                <div className="leading-tight">
                  <p className="text-sm font-semibold">Barber Demo</p>
                  <p className="text-[11px] text-white/70">Cuenta de empresa</p>
                </div>
              </div>
              <div className="space-y-3 px-3 py-5 text-[13px]">
                <Bubble side="in" time="09:00">
                  Hola Victor, te recordamos tu turno del <b>lunes 17</b> a las <b>15:30</b> en Barber Demo.
                  <br />
                  Respondé <b>1</b> para confirmar o <b>2</b> para cancelar.
                </Bubble>
                <Bubble side="out" time="09:02">
                  1
                </Bubble>
                <Bubble side="in" time="09:02">
                  ¡Gracias, Victor! Tu turno quedó confirmado. ✅
                </Bubble>
                <div className="flex justify-center pt-1">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 text-[11px] font-medium text-[#54656f] shadow-sm dark:bg-[#182229] dark:text-[#8696a0]">
                    <Clock3 className="size-3" /> 2 h antes: otro recordatorio
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Cómo funciona */}
        <section id="como-funciona" className="scroll-mt-10 border-y border-border bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <p className="text-sm font-semibold text-brand">Cómo funciona</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
              Tres pasos, cero llamadas para confirmar.
            </h2>
            <ol className="mt-12 grid gap-6 md:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="relative rounded-3xl border border-border bg-bg p-6">
                  <span className="absolute top-6 right-6 text-5xl font-black text-border tabular-nums">{i + 1}</span>
                  <span className="inline-flex rounded-2xl bg-brand-soft p-3 text-brand">{s.icon}</span>
                  <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
                  <p className="mt-2 text-muted">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Features */}
        <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-3xl border border-border bg-surface p-6 shadow-card">
                <span className="text-brand">{f.icon}</span>
                <h3 className="mt-4 font-semibold">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted">{f.text}</p>
              </li>
            ))}
          </ul>

          <div className="relative mt-16 overflow-hidden rounded-[2rem] bg-[#06281f] px-6 py-14 text-center text-white sm:px-12">
            <div
              aria-hidden
              className="absolute inset-0"
              style={{ background: "radial-gradient(60% 80% at 50% 0%, rgb(34 200 150 / 0.35), transparent 70%)" }}
            />
            <h2 className="relative text-3xl font-bold tracking-tight sm:text-4xl">Míralo funcionando</h2>
            <p className="relative mx-auto mt-3 max-w-xl text-white/70">
              Crea un turno «en 2 h 5 min» y en cinco minutos llega el recordatorio real a WhatsApp.
            </p>
            <Link
              href="/panel"
              className="relative mt-8 inline-flex items-center gap-2 rounded-xl bg-[#22c896] px-6 py-3 font-semibold text-[#04130d] transition hover:bg-[#4fd9ad]"
            >
              Entrar al panel <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted sm:px-6">
          <Logo className="text-fg" />
          <nav className="flex gap-6">
            <Link href="/privacidad" className="hover:text-fg">
              Privacidad
            </Link>
            <Link href="/eliminacion-de-datos" className="hover:text-fg">
              Eliminación de datos
            </Link>
          </nav>
          <p>Proyecto de portfolio · no es un servicio comercial</p>
        </div>
      </footer>
    </div>
  );
}

function Bubble({ side, time, children }: { side: "in" | "out"; time: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex", side === "out" && "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 shadow-sm",
          side === "in"
            ? "rounded-tl-sm bg-white text-[#111b21] dark:bg-[#202c33] dark:text-[#e9edef]"
            : "rounded-tr-sm bg-[#d9fdd3] text-[#111b21] dark:bg-[#005c4b] dark:text-[#e9edef]",
        )}
      >
        {children}
        <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-[#667781] dark:text-[#8696a0]">
          {time}
          {side === "out" && <CheckCheck className="size-3.5 text-sky-500" />}
        </span>
      </div>
    </div>
  );
}
