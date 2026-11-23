import "server-only";
import { z } from "zod";
import { requireEnv } from "@/lib/env";
import { ProviderError, type GenerateRequest, type GenerateResult, type LlmProvider } from "./types";

/**
 * Generación con Gemini por REST (capa gratuita; D-03 revisada). Sin SDK.
 * Verificado en la documentación: POST /v1beta/models/{model}:generateContent con cabecera `x-goog-api-key`;
 * `systemInstruction`, `contents[].parts[].text`, `generationConfig`; respuesta `candidates[].content.parts[].text`,
 * `finishReason`, `promptFeedback.blockReason`, `usageMetadata`.
 * NO verificado con una llamada real (falta la clave): el nombre exacto del campo de esquema JSON
 * (`responseJsonSchema`) y el formato de `thinkingLevel`. Por eso el esquema también se pide en el texto
 * y la salida SIEMPRE se valida con Zod: si el servidor ignora el campo, el resultado sigue siendo seguro.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

const REFUSAL_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "OTHER"]);

export class GeminiProvider implements LlmProvider {
  readonly name = "gemini";
  constructor(private readonly options: { apiKey?: string } = {}) {}

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const apiKey = this.options.apiKey ?? requireEnv("GEMINI_API_KEY");
    const started = Date.now();
    const jsonSchema = z.toJSONSchema(req.schema);
    const system = `${req.system}\n\nResponde SOLO con un objeto JSON que cumpla este esquema, sin texto adicional:\n${JSON.stringify(jsonSchema)}`;

    const contents = [
      ...req.history.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })),
    ];
    // El contexto recuperado va en el último turno del usuario, separado de las instrucciones fijas.
    if (contents.length === 0 || contents[contents.length - 1].role !== "user") {
      contents.push({ role: "user", parts: [{ text: req.context }] });
    } else {
      const last = contents[contents.length - 1];
      last.parts = [{ text: `${req.context}\n\n${last.parts[0].text}` }];
    }

    let response: Response;
    try {
      response = await fetch(`${BASE}/${encodeURIComponent(req.model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: {
            maxOutputTokens: req.maxOutputTokens,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
          },
        }),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch {
      throw new ProviderError("No se pudo conectar con Gemini", true);
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new ProviderError(
        response.status === 429 ? "Gemini alcanzó su límite de uso" : `Gemini respondió ${response.status}`,
        retryable,
        response.status,
      );
    }

    const body = (await response.json()) as GeminiResponse;
    const u = body.usageMetadata ?? {};
    const cacheRead = u.cachedContentTokenCount ?? 0;
    const usage = {
      input: Math.max(0, (u.promptTokenCount ?? 0) - cacheRead),
      cacheRead,
      cacheWrite: 0,
      // Los tokens de razonamiento se cobran como salida.
      output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    };
    const done = (stop: GenerateResult<T>["stop"], output: T | null = null): GenerateResult<T> => ({
      output,
      stop,
      usage,
      model: req.model,
      latencyMs: Date.now() - started,
    });

    if (body.promptFeedback?.blockReason) return done("refusal");
    const candidate = body.candidates?.[0];
    if (!candidate) return done("invalid");
    if (candidate.finishReason && REFUSAL_REASONS.has(candidate.finishReason)) return done("refusal");
    if (candidate.finishReason === "MAX_TOKENS") return done("max_tokens");

    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) return done("invalid");
    try {
      const parsed = req.schema.safeParse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
      return parsed.success ? done("ok", parsed.data) : done("invalid");
    } catch {
      return done("invalid");
    }
  }
}
