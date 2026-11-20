import { describe, expect, it } from "vitest";
import { ChannelSendError } from "@/lib/chatbot/channels/types";
import { mapSendError, SERVICE_WINDOW_MS, whatsappChannel } from "@/lib/chatbot/channels/whatsapp";
import { sendInteractiveButtons, WhatsAppApiError } from "@/lib/whatsapp/client";
import { graphFake } from "../fakes/whatsapp";

const open = { to: "+598 99 123 456", lastInboundAt: new Date() };

describe("sendInteractiveButtons", () => {
  it("payload exacto de la Cloud API", async () => {
    await sendInteractiveButtons("+598 99 123 456", "¿Quieres una persona?", [{ id: "handoff:yes", title: "Sí, con una persona" }, { id: "handoff:no", title: "No, sigo aquí" }]);
    expect(graphFake.calls).toHaveLength(1);
    expect(graphFake.calls[0].url).toMatch(/\/v26\.0\/100000000000001\/messages$/);
    expect(graphFake.calls[0].body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "59899123456",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "¿Quieres una persona?" },
        action: { buttons: [{ type: "reply", reply: { id: "handoff:yes", title: "Sí, con una persona" } }, { type: "reply", reply: { id: "handoff:no", title: "No, sigo aquí" } }] },
      },
    });
  });
  it("valida de 1 a 3 botones y títulos de hasta 20 caracteres", async () => {
    await expect(sendInteractiveButtons("1", "x", [])).rejects.toThrow("1 a 3");
    await expect(sendInteractiveButtons("1", "x", [1, 2, 3, 4].map((i) => ({ id: `${i}`, title: "a" })))).rejects.toThrow("1 a 3");
    await expect(sendInteractiveButtons("1", "x", [{ id: "a", title: "x".repeat(21) }])).rejects.toThrow("20");
    await expect(sendInteractiveButtons("1", "x", [{ id: "a", title: "" }])).rejects.toThrow("20");
    expect(graphFake.calls).toHaveLength(0);
  });
});

describe("whatsappChannel", () => {
  it("sendText dentro de la ventana de 24 h devuelve el wamid", async () => {
    const r = await whatsappChannel.sendText(open, "hola");
    expect(r.externalId).toBe(graphFake.lastWamid);
    expect(graphFake.calls[0].body).toMatchObject({ type: "text", to: "59899123456", text: { body: "hola" } });
  });
  it("sendButtons usa el envío interactivo", async () => {
    await whatsappChannel.sendButtons(open, "¿Seguimos?", [{ id: "a", title: "Sí" }]);
    expect(graphFake.interactives()).toHaveLength(1);
  });
  it.each([
    ["pasaron más de 24 h", new Date(Date.now() - SERVICE_WINDOW_MS - 1000)],
    ["no hay mensaje previo del cliente", null],
  ])("fuera de la ventana (%s): error permanente sin llamar a WhatsApp", async (_n, lastInboundAt) => {
    const error = await whatsappChannel.sendText({ to: "598", lastInboundAt }, "hola").catch((e) => e);
    expect(error).toBeInstanceOf(ChannelSendError);
    expect(error).toMatchObject({ permanent: true, reason: "window_closed" });
    expect(graphFake.calls).toHaveLength(0);
  });
  it("justo dentro de la ventana sí envía", async () => {
    await whatsappChannel.sendText({ to: "598", lastInboundAt: new Date(Date.now() - SERVICE_WINDOW_MS + 60_000) }, "hola");
    expect(graphFake.calls).toHaveLength(1);
  });
  it("un rechazo de WhatsApp (400) es permanente; 429 y 500 son transitorios", async () => {
    graphFake.failNext(400, "Número inválido");
    expect(await whatsappChannel.sendText(open, "x").catch((e) => e)).toMatchObject({ permanent: true, reason: "rejected", message: "Número inválido" });
    graphFake.failNext(429);
    expect(await whatsappChannel.sendText(open, "x").catch((e) => e)).toMatchObject({ permanent: false, reason: "rate_limited" });
    graphFake.failNext(500);
    expect(await whatsappChannel.sendText(open, "x").catch((e) => e)).toMatchObject({ permanent: false });
  });
});

describe("mapSendError", () => {
  it("131047 (fuera de ventana) es permanente; códigos de límite son transitorios", () => {
    expect(mapSendError(new WhatsAppApiError("x", 400, 131047))).toMatchObject({ permanent: true, reason: "window_closed" });
    expect(mapSendError(new WhatsAppApiError("x", 400, 131056))).toMatchObject({ permanent: false });
    expect(mapSendError(new WhatsAppApiError("x", 400, 80007))).toMatchObject({ permanent: false });
    expect(mapSendError(new WhatsAppApiError("x", 403, 190))).toMatchObject({ permanent: true });
  });
  it("un error de red cualquiera es transitorio", () => {
    expect(mapSendError(new TypeError("fetch failed"))).toMatchObject({ permanent: false, reason: "network" });
  });
});
