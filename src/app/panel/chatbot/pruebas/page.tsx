import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMember } from "@/lib/auth/session";
import { Playground } from "./playground";

export const metadata: Metadata = { title: "Probar el chatbot · RecordaYa" };

export default function PlaygroundPage() {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <PlaygroundView />
    </Suspense>
  );
}

async function PlaygroundView() {
  await requireMember("admin");
  return (
    <div className="space-y-6">
      <div className="animate-rise space-y-1">
        <Link href="/panel/chatbot" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" />
          Chatbot
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Probar el chatbot</h1>
        <p className="text-muted">
          Escribe como si fueras un cliente. No se envía nada por WhatsApp ni se guarda la conversación; el gasto sí se
          registra como «prueba».
        </p>
      </div>
      <Playground />
    </div>
  );
}
