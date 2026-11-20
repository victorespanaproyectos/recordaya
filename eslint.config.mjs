import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Los SDK de proveedores de IA solo pueden importarse dentro de src/lib/chatbot/providers/.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/chatbot/providers/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@anthropic-ai/*", "@google/genai", "@google/generative-ai", "voyageai", "openai"],
              message: "Importa los proveedores de IA solo desde src/lib/chatbot/providers/.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
