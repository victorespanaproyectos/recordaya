import { createHash } from "node:crypto";
import type { EmbeddingProvider, GenerateRequest, GenerateResult, LlmProvider } from "./types";

/** Proveedores deterministas para pruebas y desarrollo sin claves. Nunca hablan con la red. */

export const FAKE_DIMENSIONS = 1024;

/** Palabras sin significado propio: no aportan a la similitud del embedding falso. */
const STOP = new Set(["el", "la", "los", "las", "un", "una", "de", "del", "a", "en", "y", "o", "que", "es", "por", "para", "con", "se", "su", "al", "lo", "como", "mi", "tu", "me", "te"]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Vector de "bolsa de palabras" con hashing: textos con palabras en común quedan cerca (coseno). */
export function fakeVector(text: string): number[] {
  const v = new Array<number>(FAKE_DIMENSIONS).fill(0);
  for (const w of tokens(text)) {
    const h = createHash("sha256").update(w).digest();
    v[h.readUInt16BE(0) % FAKE_DIMENSIONS] += 1;
    v[h.readUInt16BE(2) % FAKE_DIMENSIONS] += 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-embedding";
  readonly dimensions = FAKE_DIMENSIONS;
  calls: { texts: string[]; kind: "query" | "document" }[] = [];
  /** Si se define, `embed` falla con este error. */
  failWith: Error | null = null;

  async embed(texts: string[], kind: "query" | "document") {
    if (this.failWith) throw this.failWith;
    this.calls.push({ texts, kind });
    return { vectors: texts.map(fakeVector), tokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0) };
  }
}

export type FakeLlmHandler = (req: GenerateRequest<unknown>) => Partial<GenerateResult<unknown>> | Promise<Partial<GenerateResult<unknown>>>;

export class FakeLlmProvider implements LlmProvider {
  readonly name = "fake";
  requests: GenerateRequest<unknown>[] = [];
  /** Respuesta de las pruebas; por defecto devuelve JSON inválido (`output: null`). */
  handler: FakeLlmHandler = () => ({ output: null, stop: "invalid" });

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.requests.push(req as GenerateRequest<unknown>);
    const r = await this.handler(req as GenerateRequest<unknown>);
    return {
      output: (r.output ?? null) as T | null,
      stop: r.stop ?? (r.output != null ? "ok" : "invalid"),
      usage: r.usage ?? { input: 100, cacheRead: 0, cacheWrite: 0, output: 20 },
      model: req.model,
      latencyMs: r.latencyMs ?? 1,
    };
  }
}

export const fakeEmbeddings = new FakeEmbeddingProvider();
export const fakeLlm = new FakeLlmProvider();
