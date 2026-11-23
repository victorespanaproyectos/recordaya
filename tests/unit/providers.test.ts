import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fakeVector, FakeEmbeddingProvider, FakeLlmProvider, FAKE_DIMENSIONS } from "@/lib/chatbot/providers/fake";
import { GeminiProvider } from "@/lib/chatbot/providers/gemini";
import { getEmbeddingProvider, getLlmProvider } from "@/lib/chatbot/providers/registry";
import { ProviderError, type GenerateRequest } from "@/lib/chatbot/providers/types";
import { VoyageEmbeddingProvider } from "@/lib/chatbot/providers/voyage";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const vec = (n: number) => new Array(n).fill(0.1);

describe("fake", () => {
  const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  it("vectores de 1024, normalizados y deterministas", () => {
    const v = fakeVector("¿A qué hora abren?");
    expect(v).toHaveLength(FAKE_DIMENSIONS);
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    expect(fakeVector("¿A qué hora abren?")).toEqual(v);
  });
  it("textos con palabras en común quedan más cerca que textos distintos", () => {
    const q = fakeVector("horario de atención");
    expect(cos(q, fakeVector("Nuestro horario de atención es de 9 a 18"))).toBeGreaterThan(cos(q, fakeVector("Aceptamos tarjetas de crédito")) + 0.2);
  });
  it("el embedding falso registra las llamadas y puede fallar", async () => {
    const p = new FakeEmbeddingProvider();
    expect((await p.embed(["a b", "c d"], "document")).vectors).toHaveLength(2);
    expect(p.calls).toHaveLength(1);
    p.failWith = new Error("x");
    await expect(p.embed(["a"], "query")).rejects.toThrow("x");
  });
  it("el LLM falso usa el manejador y por defecto devuelve invalid", async () => {
    const llm = new FakeLlmProvider();
    const req = { model: "fake", effort: "low", system: "", context: "", history: [], schema: z.object({ a: z.string() }), maxOutputTokens: 10, timeoutMs: 10 } as GenerateRequest<{ a: string }>;
    expect(await llm.generate(req)).toMatchObject({ output: null, stop: "invalid" });
    llm.handler = () => ({ output: { a: "x" } });
    expect(await llm.generate(req)).toMatchObject({ output: { a: "x" }, stop: "ok" });
  });
});

describe("registro", () => {
  it("elige por prefijo de modelo y por EMBEDDINGS_PROVIDER", () => {
    expect(getLlmProvider("fake-1").name).toBe("fake");
    expect(getLlmProvider("gemini-3.5-flash-lite").name).toBe("gemini");
    expect(() => getLlmProvider("otro")).toThrow("No hay proveedor");
    expect(getEmbeddingProvider().name).toBe("fake"); // el setup fija fake
    vi.stubEnv("EMBEDDINGS_PROVIDER", "voyage");
    expect(getEmbeddingProvider().name).toBe("voyage");
    vi.stubEnv("EMBEDDINGS_PROVIDER", "x");
    expect(() => getEmbeddingProvider()).toThrow("desconocido");
    vi.unstubAllEnvs();
  });
});

describe("Voyage", () => {
  const provider = () => new VoyageEmbeddingProvider({ apiKey: "k", model: "voyage-4-lite", dimensions: 1024, baseDelayMs: 1 });

  it("pide input_type, modelo y dimensión; devuelve vectores en orden y tokens", async () => {
    fetchMock.mockResolvedValue(json({ data: [{ index: 1, embedding: vec(1024).map((x) => x * 2) }, { index: 0, embedding: vec(1024) }], usage: { total_tokens: 12 } }));
    const r = await provider().embed(["uno", "dos"], "document");
    expect(r.tokens).toBe(12);
    expect(r.vectors[0][0]).toBe(0.1);
    expect(r.vectors[1][0]).toBe(0.2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body)).toEqual({ input: ["uno", "dos"], model: "voyage-4-lite", input_type: "document", output_dimension: 1024 });
  });

  it("divide en lotes de 64 y suma los tokens", async () => {
    fetchMock.mockImplementation(async (_u: string, init: { body: string }) => {
      const n = JSON.parse(init.body).input.length;
      return json({ data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: vec(1024) })), usage: { total_tokens: n } });
    });
    const r = await provider().embed(Array.from({ length: 150 }, (_, i) => `t${i}`), "document");
    expect(r.vectors).toHaveLength(150);
    expect(r.tokens).toBe(150);
    expect(fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).input.length)).toEqual([64, 64, 22]);
  });

  it("reintenta 429 y 5xx con espera y termina bien", async () => {
    fetchMock
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ data: [{ index: 0, embedding: vec(1024) }], usage: { total_tokens: 1 } }));
    expect((await provider().embed(["a"], "query")).vectors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("tras 4 intentos fallidos lanza un error reintentable", async () => {
    fetchMock.mockResolvedValue(json({}, 429));
    await expect(provider().embed(["a"], "query")).rejects.toMatchObject({ retryable: true, status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("no reintenta 400/401 (error permanente)", async () => {
    fetchMock.mockResolvedValue(json({}, 401));
    await expect(provider().embed(["a"], "query")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("clave") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("error de red es reintentable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(provider().embed(["a"], "query")).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("error claro si cambia la dimensión o falta algún vector", async () => {
    fetchMock.mockResolvedValue(json({ data: [{ index: 0, embedding: vec(512) }], usage: { total_tokens: 1 } }));
    await expect(provider().embed(["a"], "query")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("512 dimensiones") });
    fetchMock.mockResolvedValue(json({ data: [], usage: {} }));
    await expect(provider().embed(["a"], "query")).rejects.toMatchObject({ message: expect.stringContaining("0 vectores") });
  });
});

describe("Gemini", () => {
  const schema = z.object({ answer: z.string(), confidence: z.number() });
  const req = (over: Partial<GenerateRequest<z.infer<typeof schema>>> = {}): GenerateRequest<z.infer<typeof schema>> => ({
    model: "gemini-3.5-flash-lite", effort: "low", system: "Eres un asistente.", context: "<fuentes>x</fuentes>",
    history: [{ role: "user", content: "hola" }, { role: "assistant", content: "¡hola!" }, { role: "user", content: "¿horario?" }],
    schema, maxOutputTokens: 512, timeoutMs: 5000, ...over,
  });
  const reply = (text: string, extra: Record<string, unknown> = {}) =>
    json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 20, thoughtsTokenCount: 5 }, ...extra });
  const gemini = () => new GeminiProvider({ apiKey: "g-key" });

  it("arma la petición y devuelve la salida validada con el uso mapeado", async () => {
    fetchMock.mockResolvedValue(reply('{"answer":"De 9 a 18","confidence":0.9}'));
    const r = await gemini().generate(req());
    expect(r).toMatchObject({ output: { answer: "De 9 a 18", confidence: 0.9 }, stop: "ok", model: "gemini-3.5-flash-lite", usage: { input: 70, cacheRead: 30, cacheWrite: 0, output: 25 } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("g-key");
    expect(url).not.toContain("g-key");
    const body = JSON.parse(init.body);
    expect(body.systemInstruction.parts[0].text).toContain("Eres un asistente.");
    expect(body.systemInstruction.parts[0].text).toContain('"answer"');
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(body.contents[2].parts[0].text).toBe("<fuentes>x</fuentes>\n\n¿horario?");
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 512, responseMimeType: "application/json" });
  });

  it("si el historial no termina en el usuario, el contexto va como último turno", async () => {
    fetchMock.mockResolvedValue(reply('{"answer":"x","confidence":1}'));
    await gemini().generate(req({ history: [{ role: "assistant", content: "hola" }] }));
    const roles = JSON.parse(fetchMock.mock.calls[0][1].body).contents.map((c: { role: string }) => c.role);
    expect(roles).toEqual(["model", "user"]);
  });

  it("acepta JSON dentro de un bloque de código y descarta partes de razonamiento", async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ content: { parts: [{ text: "pensando", thought: true }, { text: '```json\n{"answer":"ok","confidence":1}\n```' }] }, finishReason: "STOP" }] }));
    expect((await gemini().generate(req())).output).toEqual({ answer: "ok", confidence: 1 });
  });

  it.each([
    ["JSON que no cumple el esquema", reply('{"answer":1}'), "invalid"],
    ["texto que no es JSON", reply("no sé"), "invalid"],
    ["respuesta vacía", reply("  "), "invalid"],
    ["sin candidatos", json({ candidates: [] }), "invalid"],
    ["bloqueo del prompt", json({ promptFeedback: { blockReason: "SAFETY" } }), "refusal"],
    ["bloqueo por seguridad", json({ candidates: [{ finishReason: "SAFETY" }] }), "refusal"],
    ["corte por longitud", json({ candidates: [{ content: { parts: [{ text: '{"ans' }] }, finishReason: "MAX_TOKENS" }] }), "max_tokens"],
  ])("%s → stop %s sin salida", async (_n, response, stop) => {
    fetchMock.mockResolvedValue(response);
    expect(await gemini().generate(req())).toMatchObject({ output: null, stop });
  });

  it("429 y 5xx son reintentables; 400 no", async () => {
    fetchMock.mockResolvedValue(json({}, 429));
    await expect(gemini().generate(req())).rejects.toMatchObject({ retryable: true, status: 429 });
    fetchMock.mockResolvedValue(json({}, 503));
    await expect(gemini().generate(req())).rejects.toMatchObject({ retryable: true });
    fetchMock.mockResolvedValue(json({}, 400));
    await expect(gemini().generate(req())).rejects.toMatchObject({ retryable: false });
    fetchMock.mockRejectedValue(new TypeError("x"));
    await expect(gemini().generate(req())).rejects.toMatchObject({ retryable: true });
  });
});
