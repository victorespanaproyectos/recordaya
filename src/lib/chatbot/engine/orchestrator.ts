import "server-only";
import { resolveModel } from "@/lib/chatbot/config";
import { getLlmProvider } from "@/lib/chatbot/providers/registry";
import { ProviderError, type GenerateResult, type LlmProvider } from "@/lib/chatbot/providers/types";
import { retrieveChunks, type RetrievedChunk } from "@/lib/chatbot/rag/retrieve";
import type { ChatbotSettings } from "@/lib/chatbot/settings";
import { renderTemplate } from "@/lib/chatbot/template";
import { assertBudget, type BudgetResult } from "@/lib/chatbot/usage/budget";
import { recordUsage, type UsageEntry } from "@/lib/chatbot/usage/meter";
import { assertFactsInSources, citedIdsAreValid, clampAnswer, detectInjectionAttempt, detectPromptLeak } from "./guardrails";
import { buildContext, buildHistory, buildSystem, type HistoryMessage } from "./prompt";
import { BotOutput } from "./schema";
import { classifyShortcut, shortcutReply, type Shortcut } from "./smalltalk";

/**
 * Orquestador de un turno (04 §14.1). La lógica de decisión es pura (`decide`); todo lo que toca la base de datos
 * o el canal entra por `TurnDeps`, así se prueba entera con proveedores falsos y una implementación en memoria.
 */

export const MAX_GROUPED_MESSAGES = 5;
export const MAX_INPUT_CHARS = 2000;
const GENERATION_ATTEMPTS = 2; // 1 + 1 reintento
const RATE_NOTICE = "Estás enviando muchos mensajes seguidos. Te respondo en unos minutos.";

export interface InboundItem {
  id: string;
  text: string | null;
  contentType: string;
}

export interface TurnContext {
  businessId: string;
  businessName: string;
  address: string | null;
  timeZone: string;
  channel: string;
  settings: ChatbotSettings;
  conversation: { id: string; status: string; consecutiveFailures: number; isFirstReply: boolean };
  contactBlocked: boolean;
  /** El mensaje disparador sigue siendo el último entrante sin responder. */
  triggerIsLatest: boolean;
  /** Ya existe una respuesta del bot a ese mensaje. */
  alreadyReplied: boolean;
  /** Entrantes sin responder desde la última salida (el más reciente al final). */
  inbound: InboundItem[];
  history: HistoryMessage[];
  summary: string | null;
  nextAppointment: string | null;
  /** "disponible ahora" o "próxima: mañana a las 9:00" (ya formateado en la zona del negocio). */
  humanAttention: string;
  /** "próximo horario" para `{proximo_horario}` en los mensajes. */
  nextOpening: string;
  /** Fecha y hora actuales ya formateadas en la zona del negocio. */
  nowLabel: string;
}

export type UnansweredReason = "no_context" | "low_confidence" | "out_of_scope" | "unsupported_content" | "handoff";
export type HandoffReason = "customer_request" | "no_information" | "low_confidence" | "unsupported_content" | "sensitive_topic" | "operator_initiated" | "budget_exhausted";

/** Lo que el turno decidió hacer. La persistencia y el envío los hace `deliver`. */
export interface Delivery {
  text: string;
  /** Mostrar los botones [Sí, con una persona] [No, sigo aquí]. */
  handoffButtons: boolean;
  /** Nuevo valor de `consecutive_failures`. */
  failures: number;
  unanswered: { reason: UnansweredReason; question: string; missing: string | null } | null;
  /** Marca `handoff_offered_at` y guarda el motivo. */
  handoffOffer: { reason: HandoffReason } | null;
  events: { type: "injection_suspected" | "send_failed" | "budget_exhausted"; payload?: Record<string, unknown> }[];
  usedSourceIds: string[];
  /** "ai" si la generó el modelo; "shortcut" / "system" si no hubo llamada. */
  source: "ai" | "shortcut" | "system";
}

export type TurnResult =
  | { outcome: "sent"; delivery: Delivery; debug?: TurnDebug }
  | { outcome: "skipped"; reason: string; debug?: TurnDebug };

export interface TurnDebug {
  chunks: RetrievedChunk[];
  output: BotOutput | null;
  guard: GuardFailure;
  stop: GenerateResult<unknown>["stop"] | null;
  usage: GenerateResult<unknown>["usage"] | null;
  model: string | null;
  retrievalQuery: string | null;
}

export type GuardFailure = "facts" | "leak" | "bad_sources" | null;

export interface TurnDeps {
  load(input: { conversationId: string; triggerMessageId: string }): Promise<TurnContext | null>;
  deliver(ctx: TurnContext, delivery: Delivery): Promise<void>;
  lock?(conversationId: string): Promise<boolean>;
  unlock?(conversationId: string): Promise<void>;
  rateLimit?(ctx: TurnContext): Promise<"ok" | "notify" | "silent">;
  budget?(businessId: string): Promise<BudgetResult>;
  retrieve?(businessId: string, query: string, conversationId: string | null): Promise<RetrievedChunk[]>;
  llm?(model: string): LlmProvider;
  recordUsage?(entry: UsageEntry): Promise<void>;
  /** Prompt confidencial por despliegue; por defecto `CHATBOT_PROMPT_CANARY`. */
  canary?: string;
}

export interface TurnInput {
  conversationId: string;
  triggerMessageId: string;
  /** Zona de pruebas: sin lease, sin precondiciones ni límites, sin entrega; el uso se registra como `playground`. */
  dryRun?: boolean;
  /** Último intento de QStash: un error transitorio del proveedor ya no se relanza; el cliente recibe el mensaje de «sin información» con la oferta (W-05). */
  finalAttempt?: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Decisión (pura): tabla de 04 §14.4
// ---------------------------------------------------------------------------------------------------------------

export interface DecideInput {
  settings: ChatbotSettings;
  failures: number;
  output: BotOutput | null;
  guard: GuardFailure;
  question: string;
  isFirstReply: boolean;
  customerGreeted: boolean;
  nextOpening: string;
  businessName: string;
}

const GREETS = /^\s*[¡!]?\s*(hola|buenas|buen d[ií]a|buenos d[ií]as|buenas (tardes|noches)|hey|hello|hi)\b/i;

function render(settings: ChatbotSettings, text: string, ctx: { businessName: string; nextOpening: string }) {
  return renderTemplate(text, { negocio: ctx.businessName, asistente: settings.assistant_name, proximo_horario: ctx.nextOpening });
}

export function decide(input: DecideInput): Delivery {
  const { settings, output, guard } = input;
  const base = { businessName: input.businessName, nextOpening: input.nextOpening };
  const noInfo = render(settings, settings.no_info_message, base);
  const offer = render(settings, settings.handoff_offer_message, base);
  const delivery = (d: Partial<Delivery> & Pick<Delivery, "text">): Delivery => {
    const result: Delivery = {
      handoffButtons: false,
      failures: input.failures,
      unanswered: null,
      handoffOffer: null,
      events: [],
      usedSourceIds: [],
      source: "ai",
      ...d,
    };
    // Los botones [Sí, con una persona] [No, sigo aquí] siempre acompañan al texto de la oferta.
    if (result.handoffButtons && !result.text.includes(offer)) result.text = `${result.text}\n\n${offer}`;
    return result;
  };
  /** Antepone la bienvenida en el primer mensaje: si el cliente saludó o si la respuesta no saluda ya. */
  const withWelcome = (answer: string) =>
    input.isFirstReply && (input.customerGreeted || !GREETS.test(answer)) ? `${render(settings, settings.welcome_message, base)}\n\n${answer}` : answer;
  const question = input.question.slice(0, 1000);

  // 1. La generación falló tras el reintento: no se inventa nada, se ofrece una persona.
  if (!output && !guard) {
    return delivery({
      text: noInfo,
      handoffButtons: true,
      unanswered: { reason: "low_confidence", question, missing: null },
      handoffOffer: { reason: "low_confidence" },
      events: [{ type: "send_failed", payload: { cause: "generation" } }],
    });
  }

  // Una guarda descartó la respuesta: se comporta como "sin respaldo", sin enviar lo que dijo el modelo.
  if (guard || !output) {
    const failures = input.failures + 1;
    return delivery({
      text: noInfo,
      failures,
      handoffButtons: failures >= settings.offer_human_after_failures,
      unanswered: { reason: guard === "leak" ? "low_confidence" : "no_context", question, missing: output?.missing_info ?? null },
      handoffOffer: failures >= settings.offer_human_after_failures ? { reason: "no_information" } : null,
      events: guard === "leak" ? [{ type: "injection_suspected", payload: { cause: "prompt_leak" } }] : [],
    });
  }

  const used = output.used_source_ids;
  const answer = clampAnswer(output.answer, settings.max_answer_chars);

  // 2. El cliente pide una persona.
  if (output.intent === "human_request") {
    return delivery({ text: offer, handoffButtons: true, handoffOffer: { reason: "customer_request" }, usedSourceIds: used });
  }
  // 3. Queja, pago o tema sensible.
  if (output.needs_human) {
    return delivery({
      text: output.grounded && answer ? `${answer}\n\n${offer}` : offer,
      handoffButtons: true,
      handoffOffer: { reason: "sensitive_topic" },
      usedSourceIds: used,
    });
  }
  // 4. Acciones sobre turnos: se explica cómo (1/2) o cuál es el turno.
  if (output.intent === "appointment_action") return delivery({ text: withWelcome(answer), usedSourceIds: used });
  // 5. Aclaración: no cuenta como fallo.
  if (output.needs_clarification) return delivery({ text: withWelcome(answer), usedSourceIds: used });
  // 6. Charla.
  if (output.intent === "smalltalk") return delivery({ text: withWelcome(answer), usedSourceIds: used });
  // 7. Fuera del alcance del negocio.
  if (output.intent === "out_of_scope") {
    return delivery({ text: withWelcome(answer), unanswered: { reason: "out_of_scope", question, missing: output.missing_info }, usedSourceIds: used });
  }
  // 8. Sin respaldo o poca confianza: se envía "sin información", nunca la respuesta del modelo.
  if (!output.grounded || output.confidence < settings.confidence_threshold) {
    const failures = input.failures + 1;
    const offerHuman = failures >= settings.offer_human_after_failures;
    return delivery({
      text: noInfo,
      failures,
      handoffButtons: offerHuman,
      unanswered: { reason: output.grounded ? "low_confidence" : "no_context", question, missing: output.missing_info },
      handoffOffer: offerHuman ? { reason: output.grounded ? "low_confidence" : "no_information" } : null,
      usedSourceIds: used,
    });
  }
  // 9. Respuesta normal.
  return delivery({ text: withWelcome(answer), failures: 0, usedSourceIds: used });
}

// ---------------------------------------------------------------------------------------------------------------
// Consulta de recuperación (04 §14.1 paso 5): sin llamada extra a la IA
// ---------------------------------------------------------------------------------------------------------------

const DEICTIC = /\b(eso|esto|esa|ese|esos|esas|aquello|ah[ií]|all[ií]|tambi[eé]n|lo mismo|y (los|las|el|la|si|para|con)\b)/i;

/** Mensajes cortos o dependientes del contexto («¿y los sábados?») se consultan junto a los 2 turnos anteriores. */
export function buildRetrievalQuery(message: string, history: HistoryMessage[]): string {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 6 && !DEICTIC.test(message)) return message;
  const previous = history.filter((m) => m.sender !== "system" && m.body).slice(-2).map((m) => m.body!.trim());
  return [...previous, message].join("\n").slice(-1000);
}

// ---------------------------------------------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------------------------------------------

function groupInbound(items: InboundItem[]): { text: string; shortcut: Shortcut } {
  const recent = items.slice(-MAX_GROUPED_MESSAGES);
  const texts = recent.map((m) => m.text?.trim()).filter((t): t is string => Boolean(t));
  const text = texts.join("\n").slice(-MAX_INPUT_CHARS);
  if (texts.length === 0) {
    return { text: "", shortcut: recent.some((m) => classifyShortcut({ contentType: m.contentType }) === "non_text") ? "non_text" : "none" };
  }
  return { text, shortcut: classifyShortcut({ text, contentType: recent.at(-1)?.contentType }) };
}

export async function runChatbotTurn(input: TurnInput, deps: TurnDeps): Promise<TurnResult> {
  const dry = input.dryRun === true;
  if (!dry && deps.lock && !(await deps.lock(input.conversationId))) {
    throw new Error("No se pudo tomar la conversación (otro turno en curso)"); // 500 → QStash reintenta
  }
  try {
    return await run(input, deps, dry);
  } finally {
    if (!dry && deps.unlock) await deps.unlock(input.conversationId);
  }
}

async function run(input: TurnInput, deps: TurnDeps, dry: boolean): Promise<TurnResult> {
  const ctx = await deps.load({ conversationId: input.conversationId, triggerMessageId: input.triggerMessageId });
  if (!ctx) return { outcome: "skipped", reason: "conversation_not_found" };

  // Precondiciones
  if (!dry) {
    if (ctx.conversation.status !== "bot") return { outcome: "skipped", reason: "not_bot_conversation" };
    if (ctx.contactBlocked) return { outcome: "skipped", reason: "contact_blocked" };
    if (ctx.alreadyReplied) return { outcome: "skipped", reason: "already_replied" };
    if (!ctx.triggerIsLatest) return { outcome: "skipped", reason: "superseded" };
  }
  if (ctx.inbound.length === 0) return { outcome: "skipped", reason: "nothing_to_answer" };

  const { settings } = ctx;
  const grouped = groupInbound(ctx.inbound);
  const question = grouped.text;
  const emptyDebug: TurnDebug = { chunks: [], output: null, guard: null, stop: null, usage: null, model: null, retrievalQuery: null };
  const send = async (delivery: Delivery, debug: TurnDebug = emptyDebug): Promise<TurnResult> => {
    if (!dry) await deps.deliver(ctx, delivery);
    return { outcome: "sent", delivery, debug: dry ? debug : undefined };
  };
  const renderCtx = { businessName: ctx.businessName, nextOpening: ctx.nextOpening };
  const failures = ctx.conversation.consecutiveFailures;
  const injection = detectInjectionAttempt(question);
  const injectionEvents: Delivery["events"] = injection.suspected ? [{ type: "injection_suspected", payload: { patterns: injection.matches } }] : [];
  const plain = (text: string, extra: Partial<Delivery> = {}): Delivery => ({
    text, handoffButtons: false, failures, unanswered: null, handoffOffer: null, events: injectionEvents, usedSourceIds: [], source: "shortcut", ...extra,
  });

  // Límite por contacto
  if (!dry && deps.rateLimit) {
    const limit = await deps.rateLimit(ctx);
    if (limit === "silent") return { outcome: "skipped", reason: "rate_limited" };
    if (limit === "notify") return send(plain(RATE_NOTICE, { source: "system" }));
  }

  // Atajos sin IA
  const reply = shortcutReply(grouped.shortcut, {
    welcome: render(settings, settings.welcome_message, renderCtx),
    unsupported: render(settings, settings.unsupported_content_message, renderCtx),
    closing: settings.closing_message ? render(settings, settings.closing_message, renderCtx) : null,
  });
  if (reply) {
    const unanswered = grouped.shortcut === "non_text" ? ({ reason: "unsupported_content", question: "(contenido no textual)", missing: null } as const) : null;
    return send(plain(reply, { unanswered }));
  }

  // Presupuesto
  const budget = await (deps.budget ?? assertBudget)(ctx.businessId);
  if (!budget.ok) {
    const noInfo = render(settings, settings.no_info_message, renderCtx);
    return send(
      plain(noInfo, {
        handoffButtons: true,
        handoffOffer: { reason: "budget_exhausted" },
        unanswered: { reason: "no_context", question: question.slice(0, 1000), missing: null },
        events: [...injectionEvents, { type: "budget_exhausted", payload: { scope: budget.scope } }],
        source: "system",
      }),
    );
  }

  // Recuperación
  const retrievalQuery = buildRetrievalQuery(question, ctx.history);
  const chunks = await (deps.retrieve ?? ((b, q, c) => retrieveChunks(b, q, { conversationId: c })))(ctx.businessId, retrievalQuery, dry ? null : ctx.conversation.id);

  // Generación (1 + 1 reintento)
  const model = resolveModel(settings.llm_model);
  const llm = (deps.llm ?? getLlmProvider)(model);
  const canary = deps.canary ?? process.env.CHATBOT_PROMPT_CANARY ?? "";
  const system = buildSystem(settings, { name: ctx.businessName }, { channel: ctx.channel === "web" ? "el sitio web" : "WhatsApp", canary: canary || undefined });
  const contextBlock = buildContext(chunks, {
    name: ctx.businessName, address: ctx.address, timeZone: ctx.timeZone, now: ctx.nowLabel, humanAttention: ctx.humanAttention, nextAppointment: ctx.nextAppointment,
  });
  const history = buildHistory(ctx.history, ctx.summary);
  // El mensaje actual (agrupado) cierra el historial como turno del usuario.
  const turns = [...history.filter((t, i) => !(i === history.length - 1 && t.role === "user" && t.content === question)), { role: "user" as const, content: question }];

  const operation = dry ? "playground" : "chat";
  const record = deps.recordUsage ?? recordUsage;
  let result: GenerateResult<BotOutput> | null = null;
  for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt++) {
    try {
      result = await llm.generate({
        model, effort: settings.llm_effort, system, context: contextBlock, history: turns, schema: BotOutput, maxOutputTokens: 1024, timeoutMs: 25_000,
      });
    } catch (error) {
      if (error instanceof ProviderError && (!error.retryable || input.finalAttempt)) {
        result = null;
        break;
      }
      throw error; // transitorio: el job devuelve 500 y QStash reintenta el turno
    }
    await record({ businessId: ctx.businessId, operation, provider: llm.name, model, usage: result.usage, latencyMs: result.latencyMs, status: result.stop === "refusal" ? "refusal" : result.stop === "ok" ? "ok" : "error", conversationId: dry ? null : ctx.conversation.id });
    if (result.stop === "ok" && result.output) break;
  }

  const output = result?.stop === "ok" ? result.output : null;
  let guard: GuardFailure = null;
  if (output) {
    const refs = chunks.map((c) => c.ref);
    const used = chunks.filter((c) => output.used_source_ids.includes(c.ref));
    const datos = [ctx.businessName, ctx.address ?? "", ctx.nowLabel, ctx.humanAttention, ctx.nextAppointment ?? ""];
    if (!citedIdsAreValid(output.used_source_ids, refs)) guard = "bad_sources";
    else if (detectPromptLeak(output.answer, { canary: canary || undefined })) guard = "leak";
    else if (!assertFactsInSources(output.answer, [...used.map((c) => c.content), ...datos]).ok) guard = "facts";
  }

  const delivery = decide({
    settings, failures, output, guard, question, isFirstReply: ctx.conversation.isFirstReply,
    customerGreeted: /^\s*[¡!]?\s*(hola|buenas|buen d[ií]a|buenos d[ií]as|hey|hello|hi)\b/i.test(question),
    ...renderCtx,
  });
  delivery.events.unshift(...injectionEvents);
  return send(delivery, { chunks, output, guard, stop: result?.stop ?? null, usage: result?.usage ?? null, model, retrievalQuery });
}
