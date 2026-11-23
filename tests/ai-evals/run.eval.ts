/**
 * Ejecutor de evaluaciones de la IA (T-07.7): `npm run eval:chatbot`.
 *
 * Carga cada fixture en un negocio de PRUEBA (base de .env.test), corre los casos de tests/ai-evals/cases.json con la
 * zona de pruebas (el mismo motor que atiende a los clientes, sin enviar nada) y escribe un reporte en
 * tests/ai-evals/reports/. Usa proveedores REALES (Gemini y Voyage: gasta su cupo); con EVAL_PROVIDER=fake corre con
 * los falsos solo para comprobar el ejecutor.
 *
 * Variables opcionales:
 *   EVAL_ONLY=AI-01,AI-07   solo esos grupos      EVAL_LIMIT=5   máximo de casos por grupo
 *   EVAL_DELAY_MS=5000      pausa entre casos     EVAL_INGEST_DELAY_MS=0   pausa entre fuentes al ingerir
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { runPlayground } from "@/lib/chatbot/engine/playground";
import { detectPromptLeak } from "@/lib/chatbot/engine/guardrails";
import { PROMPT_VERSION } from "@/lib/chatbot/engine/prompt";
import { ProviderError } from "@/lib/chatbot/providers/types";
import { ingestDocument } from "@/lib/chatbot/rag/ingest";
import { countSuspiciousChunks, createSource, getSource, type SourceInput } from "@/lib/chatbot/rag/sources";
import { DEFAULT_SETTINGS } from "@/lib/chatbot/settings";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { dbConfigured } from "../helpers/supabase-test";
import { RETRIEVAL_THRESHOLD, scoreCase, THRESHOLDS, type EvalCase, type Observed } from "./score";

const mode = process.env.EVAL_PROVIDER === "fake" ? "fake" : "real";
const num = (name: string, fallback: number) => (process.env[name] === undefined || process.env[name] === "" ? fallback : Number(process.env[name]));
const DELAY_MS = num("EVAL_DELAY_MS", mode === "fake" ? 0 : 5000);
const INGEST_DELAY_MS = num("EVAL_INGEST_DELAY_MS", 0);
const ONLY = (process.env.EVAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LIMIT = num("EVAL_LIMIT", Infinity);

const ALL_DAY = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [["00:00", "23:59"]]]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = () => getSupabaseAdmin();

interface FixtureSource { type: "faq" | "text"; title: string; category: string; question?: string; answer?: string; body?: string }
interface Fixture { name?: string; address?: string; timezone?: string; extends?: string; sources: FixtureSource[] }
const loadFixture = (name: string): Required<Pick<Fixture, "name" | "address" | "timezone">> & { sources: FixtureSource[] } => {
  const f = JSON.parse(readFileSync(`tests/ai-evals/fixtures/${name}.json`, "utf8")) as Fixture;
  if (!f.extends) return { name: f.name!, address: f.address!, timezone: f.timezone!, sources: f.sources };
  const base = loadFixture(f.extends);
  return { ...base, sources: [...base.sources, ...f.sources] };
};

function assertEnvironment() {
  if (!dbConfigured()) throw new Error("La evaluación escribe en la base de pruebas: define .env.test (SUPABASE_URL, SUPABASE_SECRET_KEY y TEST_DB_CONFIRM).");
  if (mode === "real") {
    const missing = ["GEMINI_API_KEY", "VOYAGE_API_KEY", "CHATBOT_ALLOWED_MODELS", "CHATBOT_DEFAULT_MODEL"].filter((n) => !process.env[n]);
    if (missing.length) throw new Error(`Faltan variables en .env.local para evaluar con proveedores reales: ${missing.join(", ")}`);
  }
}

interface Result { case: EvalCase; pass: boolean; reasons: string[]; retrievalHit: boolean | null; reply: string; costUsd: number; retrieved: string[]; error?: string }

describe.skipIf(!dbConfigured() && mode === "fake")("evaluación de la IA", () => {
  const businesses: string[] = [];
  afterAll(async () => {
    for (const id of businesses) await db().from("businesses").delete().eq("id", id); // cascade
  }, 120_000);

  it(`corre el set dorado (${mode})`, async () => {
    assertEnvironment();
    const all = JSON.parse(readFileSync("tests/ai-evals/cases.json", "utf8")) as EvalCase[];
    const perGroup = new Map<string, number>();
    const cases = all.filter((c) => {
      if (ONLY.length && !ONLY.includes(c.group)) return false;
      const n = (perGroup.get(c.group) ?? 0) + 1;
      perGroup.set(c.group, n);
      return n <= LIMIT;
    });
    const canary = process.env.CHATBOT_PROMPT_CANARY || `EVAL-${randomUUID()}`;
    const llmModel = mode === "fake" ? "fake-1" : "default";
    const started = Date.now();

    // 1. Un negocio por fixture, con sus fuentes ingeridas.
    const bizByFixture = new Map<string, string>();
    for (const name of [...new Set(cases.map((c) => c.fixture))]) {
      const fx = loadFixture(name);
      const { data: biz, error } = await db().from("businesses").insert({ name: `${fx.name} (evaluación)`, address: fx.address, timezone: fx.timezone }).select("id").single();
      if (error) throw error;
      businesses.push(biz.id);
      bizByFixture.set(name, biz.id);
      await db().from("chatbot_settings").insert({ business_id: biz.id, enabled: true, llm_model: llmModel, human_hours: ALL_DAY });
      const { data: member } = await db().from("business_members").insert({ business_id: biz.id, email: `eval-${biz.id.slice(0, 8)}@example.test`, display_name: "Evaluación", role: "admin", status: "active" }).select("id").single();
      const admin = { id: member!.id as string, userId: null, businessId: biz.id as string, role: "admin" as const, displayName: "Evaluación", legacy: false };
      for (const s of fx.sources) {
        const input = (s.type === "faq" ? { type: "faq", title: s.title, category: s.category, question: s.question, answer: s.answer } : { type: "text", title: s.title, category: s.category, body: s.body }) as SourceInput;
        const source = await createSource(biz.id, input, admin);
        const outcome = await ingestDocument((await getSource(biz.id, source.id)).versions[0].id);
        if (outcome.outcome !== "ready") throw new Error(`No se pudo ingerir «${s.title}» (${name}): ${JSON.stringify(outcome)}`);
        if (INGEST_DELAY_MS) await sleep(INGEST_DELAY_MS);
      }
    }

    // 2. Casos.
    const results: Result[] = [];
    let consecutiveErrors = 0;
    for (const c of cases) {
      const businessId = bizByFixture.get(c.fixture)!;
      try {
        let r;
        for (let attempt = 0; ; attempt++) {
          try {
            r = await runPlayground(businessId, [{ role: "user", text: c.question }], { canary }, { skipDailyLimit: true, nextAppointment: c.appointment ? "mañana a las 10:30 · Corte de pelo" : null });
            break;
          } catch (error) {
            if (error instanceof ProviderError && error.retryable && attempt < 3) await sleep(15_000 * 2 ** attempt);
            else throw error;
          }
        }
        if (!r.delivery) {
          results.push({ case: c, pass: false, reasons: [`el turno se omitió (${r.reason})`], retrievalHit: null, reply: "", costUsd: 0, retrieved: [] });
        } else {
          const out = r.debug?.output ?? null;
          const observed: Observed = {
            text: r.delivery.text,
            source: r.delivery.source,
            usedSourceIds: r.delivery.usedSourceIds,
            unanswered: r.delivery.unanswered,
            handoffOffered: r.delivery.handoffOffer !== null || r.delivery.handoffButtons,
            intent: out?.intent ?? null,
            needsHuman: out?.needs_human ?? false,
            leak: detectPromptLeak(r.delivery.text, { canary }),
            retrievedTitles: [...new Set((r.debug?.chunks ?? []).map((ch) => ch.title))],
          };
          const score = scoreCase(c, observed);
          results.push({ case: c, ...score, reply: r.delivery.text, costUsd: r.costUsd, retrieved: observed.retrievedTitles });
        }
        consecutiveErrors = 0;
      } catch (error) {
        consecutiveErrors++;
        results.push({ case: c, pass: false, reasons: [], retrievalHit: null, reply: "", costUsd: 0, retrieved: [], error: error instanceof Error ? error.message : String(error) });
        if (consecutiveErrors >= 5) throw new Error(`Se abortó tras 5 errores seguidos (¿clave o modelo mal configurados?). Último: ${results.at(-1)!.error}`);
      }
      if (DELAY_MS) await sleep(DELAY_MS);
    }

    // 3. Verificaciones adicionales.
    const poisonedBiz = bizByFixture.get("barberia-envenenada");
    let suspiciousMarked: number | null = null;
    if (poisonedBiz) {
      const { data: src } = await db().from("knowledge_sources").select("id").eq("business_id", poisonedBiz).eq("title", "Promociones").single();
      suspiciousMarked = await countSuspiciousChunks(poisonedBiz, src!.id);
    }

    // 4. Métricas.
    const groups = [...new Set(cases.map((c) => c.group))].sort();
    const rows = groups.map((g) => {
      const rs = results.filter((r) => r.case.group === g);
      const pass = rs.filter((r) => r.pass).length;
      const pct = Math.round((pass / rs.length) * 1000) / 10;
      return { group: g, total: rs.length, pass, pct, threshold: THRESHOLDS[g], met: pct >= THRESHOLDS[g] };
    });
    const retrievalCases = results.filter((r) => r.retrievalHit !== null);
    const retrievalPct = retrievalCases.length ? Math.round((retrievalCases.filter((r) => r.retrievalHit).length / retrievalCases.length) * 1000) / 10 : null;
    const maxChars = DEFAULT_SETTINGS.max_answer_chars;
    const answered = results.filter((r) => r.reply);
    const tooLong = answered.filter((r) => r.reply.length > maxChars);
    const cost = results.reduce((s, r) => s + r.costUsd, 0);
    const errors = results.filter((r) => r.error);

    const unmet = [
      ...rows.filter((r) => !r.met).map((r) => `${r.group}: ${r.pct} % < ${r.threshold} %`),
      ...(retrievalPct !== null && retrievalPct < RETRIEVAL_THRESHOLD ? [`Recuperación top-5: ${retrievalPct} % < ${RETRIEVAL_THRESHOLD} %`] : []),
      ...(suspiciousMarked === 0 ? ["AI-08: el fragmento envenenado no quedó marcado como sospechoso"] : []),
      ...(tooLong.length ? [`AI-13: ${tooLong.length} respuestas superan ${maxChars} caracteres`] : []),
    ];

    // 5. Reporte.
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const sample = answered.filter((_, i) => i % Math.max(1, Math.floor(answered.length / 20)) === 0).slice(0, 20);
    const md = [
      `# Evaluación de la IA · ${stamp} · ${mode === "real" ? "proveedores reales" : "proveedores FALSOS (solo prueba del ejecutor; los resultados no valen)"}`,
      "",
      `- Prompt: versión ${PROMPT_VERSION} · modelo: ${process.env.CHATBOT_DEFAULT_MODEL ?? "—"} · embeddings: ${process.env.EMBEDDINGS_MODEL || (mode === "fake" ? "fake" : "voyage-4-lite")}`,
      `- Casos ejecutados: ${results.length} de ${all.length}${ONLY.length ? ` (grupos: ${ONLY.join(", ")})` : ""}${Number.isFinite(LIMIT) ? ` (máx. ${LIMIT} por grupo)` : ""} · duración: ${Math.round((Date.now() - started) / 60000)} min`,
      `- Costo **estimado a precio de lista**: USD ${cost.toFixed(4)} (con capa gratuita no se factura) · errores de proveedor: ${errors.length}`,
      "",
      "## Resultados por grupo",
      "",
      "| Grupo | Aprobados | % | Umbral | Cumple |",
      "| --- | --- | --- | --- | --- |",
      ...rows.map((r) => `| ${r.group} | ${r.pass}/${r.total} | ${r.pct} % | ${r.threshold} % | ${r.met ? "sí" : "**NO**"} |`),
      `| Recuperación top-5 (T-05.6) | ${retrievalCases.filter((r) => r.retrievalHit).length}/${retrievalCases.length} | ${retrievalPct ?? "—"} % | ${RETRIEVAL_THRESHOLD} % | ${retrievalPct === null ? "—" : retrievalPct >= RETRIEVAL_THRESHOLD ? "sí" : "**NO**"} |`,
      `| AI-08 · fragmento envenenado marcado | ${suspiciousMarked ?? "—"} | | ≥ 1 | ${suspiciousMarked === null ? "—" : suspiciousMarked > 0 ? "sí" : "**NO**"} |`,
      `| AI-13 · longitud ≤ ${maxChars} | ${answered.length - tooLong.length}/${answered.length} | | 100 % | ${tooLong.length === 0 ? "sí" : "**NO**"} |`,
      "",
      "AI-12 (tope de gasto) no se evalúa aquí: lo cubre `tests/chatbot/job.test.ts` con proveedores falsos. AI-13 (tono) requiere revisión humana de las respuestas de abajo (≥ 18/20).",
      "",
      "## Casos fallidos",
      "",
      ...(results.filter((r) => !r.pass).length === 0 ? ["Ninguno."] : results.filter((r) => !r.pass).flatMap((r) => [
        `### ${r.case.id} — ${r.case.question}`,
        r.error ? `- Error: ${r.error}` : `- Motivos: ${r.reasons.join("; ")}`,
        `- Respuesta: ${r.reply.replace(/\n/g, " ") || "(vacía)"}`,
        `- Recuperó (en orden): ${r.retrieved.slice(0, 5).join(" · ") || "nada"}${r.case.expected.source ? ` · esperaba «${r.case.expected.source}»` : ""}`,
        "",
      ])),
      "",
      "## 20 respuestas para revisión humana de tono (AI-13)",
      "",
      ...sample.map((r) => `- **${r.case.id}** «${r.case.question}» → ${r.reply.replace(/\n/g, " ")}`),
      "",
    ].join("\n");
    mkdirSync("tests/ai-evals/reports", { recursive: true });
    const file = `tests/ai-evals/reports/${stamp}-${mode}.md`;
    writeFileSync(file, md);
    console.log(`\nReporte: ${file}\n${rows.map((r) => `${r.group}: ${r.pct} % (umbral ${r.threshold} %)`).join("\n")}\nRecuperación top-5: ${retrievalPct ?? "—"} %\nCosto estimado: USD ${cost.toFixed(4)}`);

    if (mode === "real") expect(unmet, "No se cumplen los umbrales de 09 §Pruebas de IA").toEqual([]);
    else expect(results.length).toBe(cases.length);
  });
});
