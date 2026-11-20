import type { z } from "zod";

/** Contratos de los proveedores de IA (04 §1.3). El resto del módulo solo conoce estas interfaces. */

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest<T> {
  model: string;
  effort: "low" | "medium" | "high";
  /** Instrucciones fijas (cacheables). */
  system: string;
  /** Fragmentos recuperados y datos del negocio, en bloque separado. */
  context: string;
  history: ChatTurn[];
  /** Salida estructurada obligatoria. */
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface GenerateResult<T> {
  /** `null` si hubo rechazo, corte por longitud o JSON inválido. */
  output: T | null;
  stop: "ok" | "refusal" | "max_tokens" | "invalid";
  usage: Usage;
  model: string;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], kind: "query" | "document"): Promise<{ vectors: number[][]; tokens: number }>;
}

/** Error del proveedor. `retryable` indica si tiene sentido reintentar (límite de uso, 5xx, red). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
