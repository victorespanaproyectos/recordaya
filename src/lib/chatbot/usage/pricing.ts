import type { Usage } from "@/lib/chatbot/providers/types";

/**
 * Precios de lista en USD por millón de tokens. Es un ESTIMADO de costo: la capa gratuita no se cobra,
 * pero el tope de gasto se mide contra el precio de lista para que el panel muestre lo que costaría.
 * Fuentes: páginas de precios de Google AI Studio (gemini-3.5-flash-lite: 0,30 entrada / 2,50 salida)
 * y de Voyage AI (voyage-4-lite: 0,02), consultadas al implementar. Modelos sin precio conocido cuestan 0
 * y se avisa en el log: añadirlos aquí al habilitarlos.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
  "voyage-4-lite": { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const FREE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function priceOf(model: string): { price: ModelPrice; known: boolean } {
  if (model.startsWith("fake")) return { price: FREE, known: true };
  const price = PRICES[model];
  return price ? { price, known: true } : { price: FREE, known: false };
}

/** costo = (entrada·pe + lectura de caché·pl + escritura de caché·pw + salida·ps) / 1 000 000 */
export function computeCostUsd(model: string, usage: Usage): number {
  const { price } = priceOf(model);
  const cost = (usage.input * price.input + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite + usage.output * price.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6; // columna numeric(12,6)
}
