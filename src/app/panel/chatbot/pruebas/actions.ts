"use server";

import { ServiceError } from "@/lib/appointments/service";
import { requireMember } from "@/lib/auth/session";
import { runPlayground, type PlaygroundMessage } from "@/lib/chatbot/engine/playground";
import { ProviderError } from "@/lib/chatbot/providers/types";

export interface PlaygroundResult {
  ok: boolean;
  error?: string;
  reply?: string | null;
  skipped?: string;
  handoffButtons?: boolean;
  chunks?: { ref: string; title: string; similarity: number; content: string }[];
  output?: unknown;
  guard?: string | null;
  stop?: string | null;
  model?: string | null;
  tokens?: { input: number; cacheRead: number; output: number } | null;
  costUsd?: number;
  usedSourceIds?: string[];
}

/** Prueba una conversación con el chatbot sin enviar nada ni guardarla (admin/owner). */
export async function testChatbotAction(messages: PlaygroundMessage[]): Promise<PlaygroundResult> {
  const member = await requireMember("admin");
  try {
    const r = await runPlayground(member.businessId, messages);
    if (r.reply === null) return { ok: true, reply: null, skipped: r.reason };
    return {
      ok: true,
      reply: r.reply,
      handoffButtons: r.handoffButtons,
      chunks: r.debug!.chunks.map((c) => ({ ref: c.ref, title: c.title, similarity: c.similarity, content: c.content })),
      output: r.debug!.output,
      guard: r.debug!.guard,
      stop: r.debug!.stop,
      model: r.debug!.model,
      tokens: r.debug!.usage ? { input: r.debug!.usage.input, cacheRead: r.debug!.usage.cacheRead, output: r.debug!.usage.output } : null,
      costUsd: r.costUsd,
      usedSourceIds: r.delivery!.usedSourceIds,
    };
  } catch (error) {
    if (error instanceof ServiceError) return { ok: false, error: error.message };
    if (error instanceof ProviderError) {
      return { ok: false, error: error.retryable ? "El proveedor de IA no está disponible ahora (límite de uso o conexión). Intenta en un minuto." : error.message };
    }
    console.error("[panel/chatbot/pruebas]", error instanceof Error ? error.message : "error");
    return { ok: false, error: "Algo salió mal. Intenta de nuevo en unos segundos." };
  }
}
