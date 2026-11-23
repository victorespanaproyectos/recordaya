import { describe, expect, it } from "vitest";
import { parseReplyIntent } from "@/lib/appointments/intent";

describe("parseReplyIntent (prueba de humo T-01.2 + caracterización)", () => {
  it.each([
    ["1", "confirm"],
    ["Sí!", "confirm"],
    ["1 confirmo", "confirm"],
    ["2", "cancel"],
    ["no puedo", "cancel"],
    ["Cancelar", "cancel"],
    ["hola", "unknown"],
    [null, "unknown"],
    // Comportamiento actual que RI-02 documenta (la primera palabra decide):
    ["No sé si abren el sábado", "cancel"],
  ])("%j → %s", (text, expected) => {
    expect(parseReplyIntent(text as string | null)).toBe(expected);
  });
});
