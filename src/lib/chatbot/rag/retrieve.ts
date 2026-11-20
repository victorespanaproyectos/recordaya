import "server-only";
import { getEmbeddingProvider } from "@/lib/chatbot/providers/registry";
import type { EmbeddingProvider } from "@/lib/chatbot/providers/types";
import { recordUsage } from "@/lib/chatbot/usage/meter";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/** Recuperación híbrida (04 §15.6): embedding de la consulta + `match_knowledge_chunks` (semántica + léxica + RRF). */

export const MATCH_COUNT = 8;
export const MIN_SIMILARITY = 0.3;
export const MAX_CHUNKS_PER_SOURCE = 3;
/** ≈ 2 500 tokens (4 caracteres por token). */
export const MAX_CONTEXT_CHARS = 10_000;
export const NO_SOURCES_CONTEXT = "<fuentes>(ninguna fuente relevante)</fuentes>";

export interface RetrievedChunk {
  /** Id corto para citar en la respuesta: c1, c2… */
  ref: string;
  chunkId: string;
  sourceId: string;
  title: string;
  category: string;
  content: string;
  similarity: number;
  rankScore: number;
}

interface MatchRow {
  chunk_id: string;
  source_id: string;
  title: string;
  category: string;
  content: string;
  similarity: number;
  rank_score: number;
}

export interface RetrieveOptions {
  embeddings?: EmbeddingProvider;
  matchCount?: number;
  minSimilarity?: number;
  /** Para asociar el gasto de la consulta a una conversación. */
  conversationId?: string | null;
}

/** Fragmentos relevantes para `query`, solo del negocio indicado. Sin resultados → lista vacía. */
export async function retrieveChunks(businessId: string, query: string, options: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
  const text = query.trim();
  if (!text) return [];
  const embeddings = options.embeddings ?? getEmbeddingProvider();

  const started = Date.now();
  const { vectors, tokens } = await embeddings.embed([text], "query");
  await recordUsage({
    businessId,
    operation: "embedding_query",
    provider: embeddings.name,
    model: embeddings.model,
    usage: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0 },
    latencyMs: Date.now() - started,
    conversationId: options.conversationId,
  });

  const { data, error } = await getSupabaseAdmin().rpc("match_knowledge_chunks", {
    p_business_id: businessId,
    p_query_embedding: `[${vectors[0].join(",")}]`,
    p_query_text: text,
    p_match_count: options.matchCount ?? MATCH_COUNT,
    p_min_similarity: options.minSimilarity ?? MIN_SIMILARITY,
  });
  if (error) throw error;

  const rows = ((data ?? []) as MatchRow[]).sort((a, b) => b.rank_score - a.rank_score);
  const perSource = new Map<string, number>();
  const kept: MatchRow[] = [];
  let chars = 0;
  for (const row of rows) {
    const n = perSource.get(row.source_id) ?? 0;
    if (n >= MAX_CHUNKS_PER_SOURCE) continue;
    if (kept.length > 0 && chars + row.content.length > MAX_CONTEXT_CHARS) continue;
    perSource.set(row.source_id, n + 1);
    chars += row.content.length;
    kept.push(row);
  }
  return kept.map((r, i) => ({
    ref: `c${i + 1}`,
    chunkId: r.chunk_id,
    sourceId: r.source_id,
    title: r.title,
    category: r.category,
    content: r.content,
    similarity: r.similarity,
    rankScore: r.rank_score,
  }));
}
