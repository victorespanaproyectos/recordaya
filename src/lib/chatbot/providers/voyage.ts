import "server-only";
import { requireEnv } from "@/lib/env";
import { ProviderError, type EmbeddingProvider } from "./types";

/**
 * Embeddings con Voyage AI (D-04 revisada: `voyage-4-lite`, 1024 dimensiones, 200 M de tokens gratis por cuenta).
 * Documentación consultada: POST https://api.voyageai.com/v1/embeddings, `Authorization: Bearer`,
 * campos `input`, `model`, `input_type`, `output_dimension`; respuesta `data[].embedding` + `usage.total_tokens`.
 */

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";
const BATCH_SIZE = 64;
const MAX_ATTEMPTS = 4; // 1 intento + 3 reintentos
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

interface VoyageResponse {
  data?: { embedding?: number[]; index?: number }[];
  usage?: { total_tokens?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly model: string;
  readonly dimensions: number;

  constructor(
    private readonly options: { apiKey?: string; model?: string; dimensions?: number; baseDelayMs?: number } = {},
  ) {
    this.model = options.model ?? (process.env.EMBEDDINGS_MODEL || "voyage-4-lite");
    this.dimensions = options.dimensions ?? (Number(process.env.EMBEDDINGS_DIMENSIONS) || 1024);
  }

  async embed(texts: string[], kind: "query" | "document") {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await this.requestWithRetry(batch, kind);
      const data = [...(res.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length) {
        throw new ProviderError(`Voyage devolvió ${data.length} vectores para ${batch.length} textos`, false);
      }
      for (const item of data) {
        if (!item.embedding || item.embedding.length !== this.dimensions) {
          throw new ProviderError(
            `Voyage devolvió vectores de ${item.embedding?.length ?? 0} dimensiones; se esperaban ${this.dimensions}. ` +
              "Si cambió el modelo o la dimensión, hay que migrar la columna embedding y re-procesar las fuentes.",
            false,
          );
        }
        vectors.push(item.embedding);
      }
      tokens += res.usage?.total_tokens ?? 0;
    }
    return { vectors, tokens };
  }

  private async requestWithRetry(input: string[], kind: "query" | "document"): Promise<VoyageResponse> {
    const apiKey = this.options.apiKey ?? requireEnv("VOYAGE_API_KEY");
    const base = this.options.baseDelayMs ?? 1000;
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(base * 2 ** (attempt - 1));
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ input, model: this.model, input_type: kind, output_dimension: this.dimensions }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        lastError = new ProviderError("No se pudo conectar con Voyage", true);
        continue;
      }
      if (response.ok) return (await response.json()) as VoyageResponse;

      const retryable = RETRYABLE.has(response.status);
      lastError = new ProviderError(
        response.status === 401 ? "La clave de Voyage no es válida" : `Voyage respondió ${response.status}`,
        retryable,
        response.status,
      );
      if (!retryable) throw lastError;
    }
    throw lastError ?? new ProviderError("Voyage no respondió", true);
  }
}
