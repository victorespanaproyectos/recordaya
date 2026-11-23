import "server-only";
import type { Usage } from "@/lib/chatbot/providers/types";
import { log } from "@/lib/logger";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { computeCostUsd, priceOf } from "./pricing";

export type UsageOperation = "chat" | "summary" | "embedding_query" | "embedding_ingest" | "playground";

export interface UsageEntry {
  businessId: string;
  operation: UsageOperation;
  provider: string;
  model: string;
  usage: Usage;
  latencyMs?: number;
  status?: "ok" | "error" | "refusal";
  conversationId?: string | null;
  messageId?: string | null;
}

/** Registra una llamada a un proveedor de IA en `chatbot_usage`. Un fallo al registrar nunca debe tumbar la respuesta. */
export async function recordUsage(entry: UsageEntry): Promise<void> {
  if (!priceOf(entry.model).known) log.warn("usage", "modelo sin precio conocido: el costo se registra como 0", { model: entry.model });
  const { error } = await getSupabaseAdmin().from("chatbot_usage").insert({
    business_id: entry.businessId,
    conversation_id: entry.conversationId ?? null,
    message_id: entry.messageId ?? null,
    operation: entry.operation,
    provider: entry.provider,
    model: entry.model,
    input_tokens: entry.usage.input,
    cache_read_tokens: entry.usage.cacheRead,
    cache_write_tokens: entry.usage.cacheWrite,
    output_tokens: entry.usage.output,
    cost_usd: computeCostUsd(entry.model, entry.usage),
    latency_ms: entry.latencyMs ?? null,
    status: entry.status ?? "ok",
  });
  if (error) log.error("usage", error, { msg: "no se pudo registrar el uso", operation: entry.operation });
}
