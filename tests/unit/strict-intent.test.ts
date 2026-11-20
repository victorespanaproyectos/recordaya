import { describe, expect, it } from "vitest";
import { parseReplyIntent } from "@/lib/appointments/intent";
import { parseStrictReplyIntent } from "@/lib/chatbot/strict-intent";

describe("parseStrictReplyIntent (02 §5.1)", () => {
  it.each([
    ["1", "confirm"], ["Sí", "confirm"], ["si", "confirm"], ["Sí, confirmo", "confirm"], ["confirmo", "confirm"], ["Confirmar", "confirm"], ["confirmado", "confirm"],
    ["ok", "confirm"], ["OK!", "confirm"], ["dale", "confirm"], ["voy", "confirm"], ["ok gracias", "confirm"], ["dale, voy", "confirm"], ["si ok gracias", "confirm"], ["1 ok", "confirm"],
    ["2", "cancel"], ["no", "cancel"], ["No.", "cancel"], ["no puedo", "cancel"], ["cancelo", "cancel"], ["Cancelar", "cancel"], ["cancelado", "cancel"], ["cancela", "cancel"], ["2 cancelo", "cancel"], ["no, cancelo", "cancel"],
  ])("«%s» → %s", (text, expected) => expect(parseStrictReplyIntent(text)).toBe(expected));

  it.each([
    "No sé si abren el sábado", "1 pregunta: ¿aceptan tarjeta?", "¿Puedo llevar a mi hijo?", "sí, ¿y los sábados?", "hola", "gracias por todo el servicio", "quiero cambiar mi turno",
    "no gracias quiero reservar", "si pero a otra hora", "ok, ¿a qué hora era?", "", "   ", "👍", "12", "confirmo mi turno de mañana",
  ])("«%s» → unknown (va al chatbot)", (text) => expect(parseStrictReplyIntent(text)).toBe("unknown"));

  it("mezclar confirmar y cancelar no es ninguna de las dos", () => {
    expect(parseStrictReplyIntent("si no")).toBe("unknown");
    expect(parseStrictReplyIntent("1 2")).toBe("unknown");
  });
  it("null / undefined", () => {
    expect(parseStrictReplyIntent(null)).toBe("unknown");
    expect(parseStrictReplyIntent(undefined)).toBe("unknown");
  });
  it("tildes y mayúsculas se ignoran", () => {
    expect(parseStrictReplyIntent("SÍ")).toBe("confirm");
    expect(parseStrictReplyIntent("NO PUEDO")).toBe("cancel");
  });
  it("el parser laxo de recordatorios (intent.ts) no cambia: sigue tomando solo la primera palabra", () => {
    expect(parseReplyIntent("No sé si abren el sábado")).toBe("cancel"); // por eso el chatbot usa el estricto
    expect(parseReplyIntent("1 pregunta: ¿aceptan tarjeta?")).toBe("confirm");
  });
});
