import { existsSync } from "node:fs";
import { afterEach, beforeEach, vi } from "vitest";
import { qstashFake, VALID_QSTASH_SIGNATURE } from "./fakes/qstash";
import { graphFake, installGraphFake } from "./fakes/whatsapp";
import { pendingAfter } from "./helpers/after";

// Variables de la base de pruebas (ver .env.test.example). Nunca se versiona .env.test.
if (existsSync(".env.test")) process.loadEnvFile(".env.test");

// Todo lo demás es de mentira: ninguna prueba debe poder hablar con WhatsApp real.
Object.assign(process.env, {
  WHATSAPP_ACCESS_TOKEN: "test-access-token",
  WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
  WHATSAPP_API_VERSION: "v26.0",
  WHATSAPP_TEMPLATE_LANGUAGE: "es",
  WHATSAPP_TEMPLATE_PARAM_FORMAT: "positional",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "test-verify-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  ADMIN_API_KEY: "test-admin-key",
  PANEL_PASSWORD: "test-panel-password",
  PANEL_SESSION_SECRET: "test-session-secret",
  APP_URL: "http://localhost:3000",
  QSTASH_MAX_DELAY_DAYS: "7",
  // Ninguna prueba debe hablar con un proveedor de IA real.
  EMBEDDINGS_PROVIDER: "fake",
  VOYAGE_API_KEY: "",
  GEMINI_API_KEY: "",
});

// next.config.ts activa experimental.authInterrupts (forbidden()); Next lo expone así en tiempo de ejecución.
process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "true";

vi.mock("server-only", () => ({}));

// next/cache: refresh() solo existe dentro de una Server Action real.
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));

// next/server: after() ejecuta el trabajo "después de responder"; aquí lo guardamos para esperarlo.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    // connection() solo existe dentro de una petición real.
    connection: async () => {},
    after: (task: (() => Promise<void>) | Promise<void>) => {
      pendingAfter.push(typeof task === "function" ? task() : task);
    },
  };
});

vi.mock("@/lib/scheduler/qstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduler/qstash")>();
  return {
    ...actual,
    scheduleReminder: qstashFake.scheduleReminder,
    cancelScheduled: qstashFake.cancelScheduled,
    publishJob: qstashFake.publishJob,
    verifyQStashSignature: qstashFake.verifyQStashSignature,
  };
});

beforeEach(() => {
  qstashFake.reset();
  graphFake.reset();
  pendingAfter.length = 0;
  installGraphFake();
  // Silencia los console.* esperados del código bajo prueba sin ocultar fallos reales.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

export { VALID_QSTASH_SIGNATURE };
