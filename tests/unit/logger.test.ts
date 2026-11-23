import { afterEach, describe, expect, it, vi } from "vitest";
import { log, maskPhone } from "@/lib/logger";

describe("maskPhone", () => {
  it("deja prefijo y últimos 3 dígitos", () => {
    expect(maskPhone("59899123456")).toBe("5989****456");
  });
  it("ignora símbolos y enmascara números cortos", () => {
    expect(maskPhone("+598 99 123 456")).toBe("5989****456");
    expect(maskPhone("12345")).toBe("*****");
    expect(maskPhone(null)).toBe("");
  });
});

describe("log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("escribe JSON con scope, mensaje y contexto", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("chatbot.router", "ruta elegida", { businessId: "b1", route: "legacy" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ level: "info", scope: "chatbot.router", msg: "ruta elegida", businessId: "b1", route: "legacy" });
    expect(typeof line.ts).toBe("string");
  });

  it("nunca serializa body, text, phone ni payload", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info("x", "m", { body: "hola", text: "secreto", phone: "59899123456", payload: {}, wamid: "w1" });
    const out = spy.mock.calls[0][0] as string;
    expect(out).not.toContain("hola");
    expect(out).not.toContain("secreto");
    expect(out).not.toContain("59899123456");
    expect(JSON.parse(out).wamid).toBe("w1");
  });

  it("error(Error) registra nombre y mensaje, sin stack", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    log.error("x", new TypeError("falló"), { conversationId: "c1" });
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(line).toMatchObject({ level: "error", errorName: "TypeError", error: "falló", conversationId: "c1" });
    expect(JSON.stringify(line)).not.toContain("at ");
  });
});
