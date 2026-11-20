import { vi } from "vitest";

/**
 * Intercepta `fetch` hacia graph.facebook.com: ningún mensaje de prueba sale a WhatsApp.
 * Cualquier otra URL (Supabase) pasa al `fetch` real.
 */
export interface GraphCall {
  url: string;
  body: {
    to: string;
    type: "template" | "text" | "interactive";
    template?: { name: string; components?: { parameters: { text: string }[] }[] };
    text?: { body: string };
    interactive?: { type: string; body: { text: string }; action: { buttons: { type: string; reply: { id: string; title: string } }[] } };
  };
}

type Outcome = { status: number; json: unknown };

export const graphFake = {
  calls: [] as GraphCall[],
  queue: [] as Outcome[],
  counter: 0,
  reset() {
    this.calls = [];
    this.queue = [];
    this.counter = 0;
  },
  /** La próxima llamada a la Cloud API responderá con este error. */
  failNext(status: number, message = "Error simulado") {
    this.queue.push({ status, json: { error: { message, code: status === 400 ? 131026 : 1 } } });
  },
  templates() {
    return this.calls.filter((c) => c.body.type === "template").map((c) => c.body.template!.name);
  },
  texts() {
    return this.calls.filter((c) => c.body.type === "text").map((c) => c.body.text!.body);
  },
  interactives() {
    return this.calls.filter((c) => c.body.type === "interactive").map((c) => c.body.interactive!);
  },
  lastWamid: "",
};

export function installGraphFake() {
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://graph.facebook.com/")) return realFetch(input, init);

    graphFake.calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const queued = graphFake.queue.shift();
    if (queued) return Response.json(queued.json, { status: queued.status });

    const wamid = `wamid.TEST.OUT.${++graphFake.counter}.${Math.random().toString(36).slice(2, 8)}`;
    graphFake.lastWamid = wamid;
    return Response.json({
      messaging_product: "whatsapp",
      contacts: [{ input: "x", wa_id: "x" }],
      messages: [{ id: wamid }],
    });
  });
}
