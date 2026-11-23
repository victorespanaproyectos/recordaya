import { describe, expect, it } from "vitest";
import { classifyShortcut, FAREWELL_REPLY, shortcutReply, THANKS_REPLY } from "@/lib/chatbot/engine/smalltalk";

describe("classifyShortcut", () => {
  it.each([
    ["hola", "greeting"], ["Hola!", "greeting"], ["holaaa", "greeting"], ["¡Buenas tardes!", "greeting"], ["buen día", "greeting"], ["Hey", "greeting"], ["hola, ¿qué tal?", "greeting"],
    ["gracias", "thanks"], ["gracias!!", "thanks"], ["Muchas gracias", "thanks"], ["MIL GRACIAS!!!", "thanks"], ["ok gracias", "thanks"], ["👍", "thanks"], ["🙏🙏", "thanks"], ["👍 😊", "thanks"],
    ["chau", "farewell"], ["Adiós!", "farewell"], ["hasta luego", "farewell"], ["nos vemos", "farewell"],
  ])("%s → %s", (text, expected) => expect(classifyShortcut({ text })).toBe(expected));

  it.each([
    "hola, ¿a qué hora abren?", "gracias, ¿y los sábados?", "ok", "dale", "sí", "¿horario?", "quiero un turno", "chau, ¿hasta qué hora abren hoy?", "no gracias, quiero cancelar",
  ])("%s pasa por la IA", (text) => expect(classifyShortcut({ text })).toBe("none"));

  it("contenido que no es texto, aunque traiga texto", () => {
    for (const contentType of ["image", "audio", "voice", "video", "document", "sticker", "location", "contacts"]) {
      expect(classifyShortcut({ contentType, text: null })).toBe("non_text");
    }
    expect(classifyShortcut({ contentType: "image", text: "mira esto" })).toBe("non_text");
    expect(classifyShortcut({ contentType: "text", text: "hola" })).toBe("greeting");
  });
  it("vacío → ninguno", () => {
    expect(classifyShortcut({ text: "   " })).toBe("none");
    expect(classifyShortcut({})).toBe("none");
  });
});

describe("shortcutReply", () => {
  const messages = { welcome: "¡Hola!", unsupported: "Solo texto", closing: null as string | null };
  it("usa los mensajes configurados", () => {
    expect(shortcutReply("greeting", messages)).toBe("¡Hola!");
    expect(shortcutReply("non_text", messages)).toBe("Solo texto");
    expect(shortcutReply("thanks", messages)).toBe(THANKS_REPLY);
    expect(shortcutReply("farewell", messages)).toBe(FAREWELL_REPLY);
    expect(shortcutReply("farewell", { ...messages, closing: "Chau, cuídate" })).toBe("Chau, cuídate");
    expect(shortcutReply("none", messages)).toBeNull();
  });
});
