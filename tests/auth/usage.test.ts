/** Precios, registro de consumo y topes de gasto (T-06.4). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startOfMonth, assertBudget } from "@/lib/chatbot/usage/budget";
import { recordUsage } from "@/lib/chatbot/usage/meter";
import { computeCostUsd, priceOf, PRICES } from "@/lib/chatbot/usage/pricing";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, type TestBusiness } from "../helpers/supabase-test";

describe("pricing", () => {
  it("costo = (entrada·pe + caché·pl + escritura·pw + salida·ps) / 1 000 000", () => {
    const p = PRICES["gemini-3.5-flash-lite"];
    const usage = { input: 2000, cacheRead: 1000, cacheWrite: 500, output: 400 };
    const expected = (2000 * p.input + 1000 * p.cacheRead + 500 * p.cacheWrite + 400 * p.output) / 1e6;
    expect(computeCostUsd("gemini-3.5-flash-lite", usage)).toBeCloseTo(expected, 6);
    expect(computeCostUsd("gemini-3.5-flash-lite", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0.3);
    expect(computeCostUsd("gemini-3.5-flash-lite", { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 })).toBe(2.5);
    expect(computeCostUsd("voyage-4-lite", { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0.02);
  });
  it("los modelos falsos son gratis y los desconocidos cuestan 0 pero se marcan", () => {
    expect(computeCostUsd("fake-embedding", { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 })).toBe(0);
    expect(priceOf("fake-x")).toMatchObject({ known: true });
    expect(priceOf("modelo-nuevo")).toMatchObject({ known: false });
    expect(computeCostUsd("modelo-nuevo", { input: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0);
  });
  it("redondea a 6 decimales (numeric(12,6))", () => {
    expect(computeCostUsd("gemini-3.5-flash-lite", { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 })).toBe(0.000003);
  });
});

describe("startOfMonth", () => {
  it("1.º del mes a las 00:00 locales, en UTC", () => {
    expect(startOfMonth(new Date("2026-11-19T15:00:00Z"), "America/Montevideo").toISOString()).toBe("2026-11-01T03:00:00.000Z");
    // 01:00 UTC del 1 de diciembre sigue siendo 30 de noviembre en Montevideo.
    expect(startOfMonth(new Date("2026-12-01T01:00:00Z"), "America/Montevideo").toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(startOfMonth(new Date("2026-12-01T05:00:00Z"), "America/Montevideo").toISOString()).toBe("2026-12-01T03:00:00.000Z");
  });
});

describe.skipIf(!dbConfigured())("recordUsage y assertBudget", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  const db = () => getSupabaseAdmin();
  const NOW = new Date();

  const spend = (businessId: string, costUsd: number, createdAt = NOW) =>
    db().from("chatbot_usage").insert({ business_id: businessId, operation: "chat", provider: "x", model: "x", cost_usd: costUsd, created_at: createdAt.toISOString() });
  const setBudget = (businessId: string, usd: number) => db().from("chatbot_settings").upsert({ business_id: businessId, monthly_budget_usd: usd });

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);

  it("recordUsage guarda tokens y el costo calculado", async () => {
    await recordUsage({ businessId: a.id, operation: "chat", provider: "gemini", model: "gemini-3.5-flash-lite", usage: { input: 1000, cacheRead: 200, cacheWrite: 0, output: 100 }, latencyMs: 350 });
    const { data } = await db().from("chatbot_usage").select("*").eq("business_id", a.id).eq("provider", "gemini").single();
    expect(data).toMatchObject({ operation: "chat", model: "gemini-3.5-flash-lite", input_tokens: 1000, cache_read_tokens: 200, output_tokens: 100, latency_ms: 350, status: "ok" });
    expect(Number(data!.cost_usd)).toBeCloseTo((1000 * 0.3 + 200 * 0.03 + 100 * 2.5) / 1e6, 6);
  });

  it("recordUsage no lanza si falla (no debe tumbar una respuesta)", async () => {
    await expect(recordUsage({ businessId: "no-es-uuid", operation: "chat", provider: "x", model: "x", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } })).resolves.toBeUndefined();
  });

  it("sin configuración usa el tope por defecto (20 USD): bajo el tope sí, al alcanzarlo no", async () => {
    expect(await assertBudget(a.id)).toEqual({ ok: true });
    await spend(a.id, 19.99);
    expect(await assertBudget(a.id)).toEqual({ ok: true });
    await spend(a.id, 0.01);
    expect(await assertBudget(a.id)).toEqual({ ok: false, reason: "budget_exhausted", scope: "business_monthly" });
  });

  it("el tope del negocio manda y un tope 0 bloquea; los demás negocios no se ven afectados", async () => {
    await setBudget(a.id, 100);
    expect(await assertBudget(a.id)).toEqual({ ok: true });
    await setBudget(b.id, 0);
    expect(await assertBudget(b.id)).toMatchObject({ ok: false, scope: "business_monthly" });
    await setBudget(a.id, 20);
    expect(await assertBudget(a.id)).toMatchObject({ ok: false });
    expect(await assertBudget(b.id)).toMatchObject({ ok: false }); // sigue en 0
    await setBudget(b.id, 50);
    expect(await assertBudget(b.id)).toEqual({ ok: true });
  });

  it("el gasto de meses anteriores no cuenta", async () => {
    const c = await createTestBusiness();
    try {
      const lastMonth = new Date(startOfMonth(NOW, c.timezone).getTime() - 24 * 3600 * 1000);
      await spend(c.id, 500, lastMonth);
      expect(await assertBudget(c.id)).toEqual({ ok: true });
    } finally {
      await cleanup(c.id);
    }
  });

  it("tope global diario: se mide sobre todos los negocios del día (UTC)", async () => {
    process.env.CHATBOT_GLOBAL_DAILY_BUDGET_USD = "0.5";
    try {
      const c = await createTestBusiness();
      try {
        await setBudget(c.id, 1000);
        const before = await assertBudget(c.id);
        // Otros negocios de la base real pueden haber gastado hoy; lo determinante es que superar el tope lo bloquee.
        await spend(c.id, 0.6);
        expect(await assertBudget(c.id)).toEqual({ ok: false, reason: "budget_exhausted", scope: "global_daily" });
        expect(before.ok || before.scope === "global_daily").toBe(true);
      } finally {
        await cleanup(c.id);
      }
    } finally {
      delete process.env.CHATBOT_GLOBAL_DAILY_BUDGET_USD;
    }
  });
});
