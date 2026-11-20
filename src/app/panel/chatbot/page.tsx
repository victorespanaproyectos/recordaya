import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { requireMember } from "@/lib/auth/session";
import { getAllowedModels } from "@/lib/chatbot/config";
import { getChatbotSettings } from "@/lib/chatbot/settings";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Chatbot · RecordaYa" };

export default function ChatbotPage() {
  return (
    <Suspense fallback={<div className="h-96 animate-pulse rounded-2xl bg-surface-2" />}>
      <ChatbotSettingsView />
    </Suspense>
  );
}

async function ChatbotSettingsView() {
  const member = await requireMember("admin");
  const [settings, businessRes] = await Promise.all([
    getChatbotSettings(member.businessId),
    getSupabaseAdmin().from("businesses").select("name, timezone").eq("id", member.businessId).single(),
  ]);
  if (businessRes.error) throw businessRes.error;

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <p className="text-sm font-medium text-brand">{businessRes.data.name}</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">Chatbot</h1>
        <p className="mt-1 text-muted">Cómo atiende el asistente y cuándo pasa la conversación a una persona.</p>
        <p className="mt-2 flex gap-4 text-sm font-medium">
          <Link href="/panel/chatbot/pruebas" className="text-brand hover:underline">
            Probar el chatbot →
          </Link>
          <Link href="/panel/chatbot/metricas" className="text-brand hover:underline">
            Ver métricas →
          </Link>
        </p>
      </div>
      <SettingsForm
        settings={settings}
        businessName={businessRes.data.name}
        timeZone={businessRes.data.timezone}
        isOwner={member.role === "owner"}
        allowedModels={getAllowedModels()}
      />
    </div>
  );
}
