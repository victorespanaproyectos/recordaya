import { beforeEach, describe, expect, it, vi } from "vitest";

const publishJSON = vi.fn();
vi.mock("@upstash/qstash", () => ({
  Client: class {
    publishJSON = publishJSON;
    messages = { delete: vi.fn() };
  },
  Receiver: class {},
}));

import { qstashFake } from "../fakes/qstash";

// El setup global sustituye estas funciones por falsas: aquí se prueba la versión real.
const actualModule = vi.importActual<typeof import("@/lib/scheduler/qstash")>("@/lib/scheduler/qstash");
const publishJob: typeof import("@/lib/scheduler/qstash").publishJob = async (...args) => (await actualModule).publishJob(...args);
void qstashFake;

describe("publishJob", () => {
  beforeEach(() => {
    publishJSON.mockReset();
    publishJSON.mockResolvedValue({ messageId: "msg_1" });
    process.env.APP_URL = "https://app.example.test/";
    process.env.QSTASH_TOKEN = "t";
    delete process.env.QSTASH_DEV;
  });

  it("publica en la URL de la app con demora, deduplicación y reintentos", async () => {
    const id = await publishJob("/api/jobs/chatbot-reply", { a: 1 }, { delaySeconds: 2.5, deduplicationId: "d-1", retries: 5 });
    expect(id).toBe("msg_1");
    expect(publishJSON).toHaveBeenCalledWith({
      url: "https://app.example.test/api/jobs/chatbot-reply",
      body: { a: 1 },
      delay: 3,
      deduplicationId: "d-1",
      retries: 5,
      label: "chatbot-reply",
    });
  });

  it("sin opciones: sin demora ni deduplicación, 3 reintentos", async () => {
    await publishJob("/api/jobs/knowledge-ingest", { documentId: "x" });
    const arg = publishJSON.mock.calls[0][0];
    expect(arg).not.toHaveProperty("delay");
    expect(arg).not.toHaveProperty("deduplicationId");
    expect(arg.retries).toBe(3);
  });

  it("rechaza rutas fuera de /api/jobs/", async () => {
    await expect(publishJob("/api/appointments", {})).rejects.toThrow("Ruta de job no permitida");
    await expect(publishJob("https://evil.test/api/jobs/x", {})).rejects.toThrow();
    expect(publishJSON).not.toHaveBeenCalled();
  });

  it("falla si QStash no devuelve messageId", async () => {
    publishJSON.mockResolvedValue([{ url: "x" }]);
    await expect(publishJob("/api/jobs/chatbot-reply", {})).rejects.toThrow("messageId");
  });

  it("scheduleReminder conserva su comportamiento", async () => {
    // El setup lo reemplaza por el falso; aquí se comprueba la versión real vía importActual.
    const actual = await vi.importActual<typeof import("@/lib/scheduler/qstash")>("@/lib/scheduler/qstash");
    const at = new Date("2030-01-01T10:00:00Z");
    await actual.scheduleReminder("m-1", at);
    expect(publishJSON).toHaveBeenCalledWith({
      url: "https://app.example.test/api/jobs/send-reminder",
      body: { messageId: "m-1" },
      notBefore: Math.floor(at.getTime() / 1000),
      deduplicationId: `reminder-m-1-${at.getTime()}`,
      retries: 3,
      label: "reminder",
    });
  });
});
