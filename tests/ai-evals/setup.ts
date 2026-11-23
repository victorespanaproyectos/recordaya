import { existsSync } from "node:fs";
import { vi } from "vitest";
import { qstashFake } from "../fakes/qstash";

/**
 * Entorno del ejecutor de evaluaciones. Base de datos: SIEMPRE la de pruebas (.env.test, con TEST_DB_CONFIRM).
 * Claves de IA y modelos: de .env.local (no pisa lo ya definido, así que la base de .env.test gana).
 */
if (existsSync(".env.test")) process.loadEnvFile(".env.test");
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

if (process.env.EVAL_PROVIDER === "fake") {
  // Prueba del propio ejecutor sin claves ni costo: proveedores falsos.
  Object.assign(process.env, { EMBEDDINGS_PROVIDER: "fake", CHATBOT_ALLOWED_MODELS: "fake-1", CHATBOT_DEFAULT_MODEL: "fake-1" });
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
// Ningún job real: la ingesta se ejecuta aquí mismo.
vi.mock("@/lib/scheduler/qstash", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/scheduler/qstash")>()),
  publishJob: qstashFake.publishJob,
}));
