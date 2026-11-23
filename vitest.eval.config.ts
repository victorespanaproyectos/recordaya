import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Evaluación de la IA (T-07.7): `npm run eval:chatbot`. Usa proveedores REALES salvo EVAL_PROVIDER=fake. No corre en CI. */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/ai-evals/setup.ts"],
    include: ["tests/ai-evals/**/*.eval.ts"],
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
