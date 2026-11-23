import "server-only";
import { fakeEmbeddings, fakeLlm } from "./fake";
import { GeminiProvider } from "./gemini";
import type { EmbeddingProvider, LlmProvider } from "./types";
import { VoyageEmbeddingProvider } from "./voyage";

/**
 * Elige la implementación. Las pruebas usan siempre los falsos (`fake-*` y EMBEDDINGS_PROVIDER=fake).
 * Fuera de esta carpeta está prohibido importar SDK de proveedores (regla ESLint no-restricted-imports).
 */

/** Generación según el prefijo del modelo: `fake*` → falso, `gemini-*` → Gemini. */
export function getLlmProvider(model: string): LlmProvider {
  if (model.startsWith("fake")) return fakeLlm;
  if (model.startsWith("gemini-")) return new GeminiProvider();
  throw new Error(`No hay proveedor de generación para el modelo "${model}"`);
}

/** Embeddings según EMBEDDINGS_PROVIDER (por defecto `voyage`). */
export function getEmbeddingProvider(): EmbeddingProvider {
  const name = process.env.EMBEDDINGS_PROVIDER || "voyage";
  if (name === "fake") return fakeEmbeddings;
  if (name === "voyage") return new VoyageEmbeddingProvider();
  throw new Error(`Proveedor de embeddings desconocido: ${name}`);
}
