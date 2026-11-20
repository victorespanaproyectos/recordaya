import { describe, expect, it } from "vitest";
import { describeNextOpening, isWithinHumanHours, nextOpening, type HumanHours } from "@/lib/chatbot/conversations/hours";

const TZ = "America/Montevideo"; // UTC-3 todo el año
/** Hora local de Montevideo → instante UTC. */
const at = (local: string) => new Date(`${local}:00-03:00`);
const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

const H: HumanHours = {
  mon: [["09:00", "13:00"], ["15:00", "19:00"]],
  tue: [["09:00", "13:00"], ["15:00", "19:00"]],
  wed: [["09:00", "13:00"], ["15:00", "19:00"]],
  thu: [["09:00", "13:00"], ["15:00", "19:00"]],
  fri: [["09:00", "13:00"], ["15:00", "19:00"]],
  sat: [["09:00", "13:00"]],
  exceptions: [{ date: "2026-11-26", closed: true }], // jueves feriado
};
// 2026-11-19 es jueves.

describe("isWithinHumanHours", () => {
  it.each([
    ["2026-11-19T10:00", true, "dentro de la mañana"],
    ["2026-11-19T09:00", true, "el inicio es inclusivo"],
    ["2026-11-19T12:59", true, "último minuto"],
    ["2026-11-19T13:00", false, "el fin es exclusivo"],
    ["2026-11-19T14:00", false, "entre franjas"],
    ["2026-11-19T15:00", true, "segunda franja"],
    ["2026-11-19T19:00", false, "después de la última franja"],
    ["2026-11-19T08:59", false, "antes de abrir"],
    ["2026-11-22T12:00", false, "domingo sin franjas"],
    ["2026-11-21T10:00", true, "sábado"],
    ["2026-11-21T15:00", false, "sábado por la tarde"],
    ["2026-11-26T10:00", false, "excepción cerrada (jueves feriado)"],
    ["2026-11-27T10:00", true, "el día siguiente a la excepción"],
  ])("%s → %s (%s)", (local, expected) => {
    expect(isWithinHumanHours(H, TZ, at(local))).toBe(expected);
  });

  it("usa el día local, no el de UTC (23:30 del jueves ya es viernes en UTC)", () => {
    const night: HumanHours = { thu: [["22:00", "23:59"]] };
    const now = at("2026-11-19T23:30");
    expect(now.toISOString()).toBe("2026-11-20T02:30:00.000Z");
    expect(isWithinHumanHours(night, TZ, now)).toBe(true);
    expect(isWithinHumanHours({ fri: [["00:00", "05:00"]] }, TZ, now)).toBe(false);
  });

  it("horario vacío: nunca hay atención", () => {
    expect(isWithinHumanHours({}, TZ, at("2026-11-19T10:00"))).toBe(false);
  });

  it("respeta otra zona horaria", () => {
    const utc: HumanHours = { thu: [["09:00", "10:00"]] };
    expect(isWithinHumanHours(utc, "UTC", new Date("2026-11-19T09:30:00Z"))).toBe(true);
    expect(isWithinHumanHours(utc, TZ, new Date("2026-11-19T09:30:00Z"))).toBe(false); // 06:30 en Montevideo
  });
});

describe("nextOpening + describeNextOpening", () => {
  const next = (local: string) => {
    const now = at(local);
    const d = nextOpening(H, TZ, now);
    return d ? describeNextOpening(d, TZ, now) : null;
  };

  it("entre franjas del mismo día → «hoy a las 15:00»", () => {
    expect(next("2026-11-19T14:00")).toBe("hoy a las 15:00");
  });
  it("durante una franja no cuenta la actual: la próxima que empieza", () => {
    expect(next("2026-11-19T10:00")).toBe("hoy a las 15:00");
  });
  it("justo al inicio de una franja, la siguiente es posterior", () => {
    expect(next("2026-11-19T15:00")).toBe("mañana a las 9:00");
  });
  it("después de cerrar → «mañana a las 9:00»", () => {
    expect(next("2026-11-19T20:00")).toBe("mañana a las 9:00");
  });
  it("antes de abrir el mismo día → «hoy a las 9:00»", () => {
    expect(next("2026-11-19T07:00")).toBe("hoy a las 9:00");
  });
  it("fin de semana → «el lunes 23 a las 9:00»", () => {
    expect(next("2026-11-21T14:00")).toBe("el lunes 23 a las 9:00");
    expect(next("2026-11-22T10:00")).toBe("mañana a las 9:00");
  });
  it("salta las excepciones cerradas → «el viernes 27 a las 9:00»", () => {
    expect(next("2026-11-25T20:00")).toBe("el viernes 27 a las 9:00");
  });
  it("horario vacío o solo excepciones → null", () => {
    expect(nextOpening({}, TZ, at("2026-11-19T10:00"))).toBeNull();
    expect(nextOpening({ exceptions: [{ date: "2026-11-19", closed: true }] }, TZ, at("2026-11-19T10:00"))).toBeNull();
  });
  it("devuelve el instante correcto en UTC", () => {
    expect(nextOpening(H, TZ, at("2026-11-19T14:00"))!.toISOString()).toBe("2026-11-19T18:00:00.000Z");
  });
  it("cruce de mes y de año", () => {
    const h: HumanHours = { fri: [["10:00", "12:00"]] };
    const now = at("2026-12-30T12:00"); // miércoles
    const d = nextOpening(h, TZ, now)!;
    expect(describeNextOpening(d, TZ, now)).toBe("el viernes 1 a las 10:00");
    expect(dayOf(d)).toBe("2027-01-01");
  });
});
