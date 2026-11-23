import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, HumanHoursSchema, renderTemplate, SettingsSchema } from "@/lib/chatbot/settings";

beforeEach(() => vi.stubEnv("CHATBOT_ALLOWED_MODELS", "m-a"));

const errorOf = (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, value: unknown) => {
  const r = schema.safeParse(value);
  return r.success ? null : r.error!.issues.map((i) => i.message).join(" | ");
};
const partial = SettingsSchema.partial();

describe("SettingsSchema", () => {
  it("los valores por defecto son válidos", () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });
  it("recorta espacios y guarda vacío como nulo", () => {
    const r = partial.parse({ assistant_name: "  Sofi ", personality: "   ", closing_message: "" });
    expect(r).toEqual({ assistant_name: "Sofi", personality: null, closing_message: null });
  });
  it.each([
    [{ assistant_name: "" }, "El nombre del asistente no puede estar vacío"],
    [{ assistant_name: "x".repeat(41) }, "hasta 40"],
    [{ welcome_message: "  " }, "bienvenida no puede estar vacío"],
    [{ instructions: "x".repeat(4001) }, "hasta 4000"],
    [{ business_description: "x".repeat(1001) }, "hasta 1000"],
    [{ max_answer_chars: 100 }, "entre 200 y 1500"],
    [{ max_answer_chars: 700.5 }, "entero"],
    [{ offer_human_after_failures: 6 }, "entre 1 y 5"],
    [{ inactivity_close_hours: 0 }, "entre 1 y 168"],
    [{ confidence_threshold: 1.5 }, "entre 0 y 1"],
    [{ monthly_budget_usd: -1 }, "negativo"],
    [{ tone: "gracioso" }, "Tono inválido"],
    [{ llm_effort: "max" }, "Esfuerzo inválido"],
    [{ language: "Español" }, "Idioma inválido"],
    [{ llm_model: "modelo-raro" }, "no está permitido"],
    [{ unknown_field: 1 }, ""],
  ])("rechaza %j", (input, fragment) => {
    const e = errorOf(partial, input);
    expect(e).not.toBeNull();
    expect(e).toContain(fragment);
  });
  it("acepta 'default' y los modelos de la lista blanca", () => {
    expect(partial.safeParse({ llm_model: "default" }).success).toBe(true);
    expect(partial.safeParse({ llm_model: "m-a" }).success).toBe(true);
  });
});

describe("HumanHoursSchema", () => {
  it("acepta franjas válidas y excepciones", () => {
    expect(HumanHoursSchema.safeParse({ mon: [["09:00", "13:00"], ["13:00", "18:00"]], exceptions: [{ date: "2026-12-25", closed: true }] }).success).toBe(true);
    expect(HumanHoursSchema.safeParse({}).success).toBe(true);
  });
  it.each([
    [{ mon: [["9:00", "13:00"]] }, "HH:MM"],
    [{ mon: [["09:00", "24:00"]] }, "HH:MM"],
    [{ mon: [["13:00", "09:00"]] }, "anterior al fin"],
    [{ mon: [["09:00", "09:00"]] }, "anterior al fin"],
    [{ mon: [["09:00", "13:00"], ["12:00", "18:00"]] }, "se solapan"],
    [{ mon: [["15:00", "18:00"], ["09:00", "16:00"]] }, "se solapan"],
    [{ lunes: [["09:00", "13:00"]] }, ""],
    [{ exceptions: [{ date: "2026-02-30", closed: true }] }, "no existe"],
    [{ exceptions: [{ date: "25/12/2026", closed: true }] }, "AAAA-MM-DD"],
    [{ exceptions: [{ date: "2026-12-25", closed: true }, { date: "2026-12-25", closed: true }] }, "repetida"],
    [{ exceptions: [{ date: "2026-12-25", closed: false }] }, ""],
  ])("rechaza %j", (input, fragment) => {
    const e = errorOf(HumanHoursSchema, input);
    expect(e).not.toBeNull();
    expect(e).toContain(fragment);
  });
});

describe("renderTemplate", () => {
  it("sustituye las tres variables, todas las veces que aparezcan", () => {
    expect(renderTemplate("Hola, soy {asistente} de {negocio}. {negocio}!", { asistente: "Sofi", negocio: "Barbería Sur" })).toBe("Hola, soy Sofi de Barbería Sur. Barbería Sur!");
    expect(renderTemplate("Te responderemos {proximo_horario}.", { proximo_horario: "mañana a las 9:00" })).toBe("Te responderemos mañana a las 9:00.");
  });
  it("deja intactas las variables sin valor y las desconocidas", () => {
    expect(renderTemplate("{negocio} {otra} {asistente}", { negocio: "X" })).toBe("X {otra} {asistente}");
  });
  it("una sola pasada: un valor con llaves no se vuelve a expandir", () => {
    expect(renderTemplate("{negocio}", { negocio: "{asistente}", asistente: "NO" })).toBe("{asistente}");
  });
});
