/**
 * Caracterización del webhook de WhatsApp: verificación y firma.
 * R-12, R-13 (comportamiento de `main` @ f1ad32b).
 */
import { describe, expect, it } from "vitest";
import { graphFake } from "../fakes/whatsapp";
import { hasDb, setupTestBusiness } from "../helpers/regression";
import { db, testPhone } from "../helpers/supabase-test";
import { getWebhook, inboundPayload, newInboundId, postWebhook, sign } from "../helpers/webhook";

setupTestBusiness(); // limpia teléfonos y webhooks de prueba al terminar

describe("Regresión · webhook de WhatsApp", () => {
  it("R-13 verificación GET con token correcto devuelve el challenge", async () => {
    const res = await getWebhook("hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=abc123");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("R-13 verificación GET con token incorrecto → 403", async () => {
    const res = await getWebhook("hub.mode=subscribe&hub.verify_token=otro&hub.challenge=abc123");
    expect(res.status).toBe(403);
  });

  it.each([
    ["firma alterada", () => sign("{}")],
    ["sin firma", () => null],
    ["firma con otro secreto", () => sign("{}", "otro-secreto")],
  ])("R-12 %s → 401", async (_name, makeSignature) => {
    const res = await postWebhook(inboundPayload({ from: testPhone(), text: "Hola" }), {
      signature: makeSignature(),
    });
    expect(res.status).toBe(401);
    expect(graphFake.calls).toHaveLength(0);
  });
});

describe.skipIf(!hasDb)("Regresión · webhook con base de datos", () => {
  it("R-12 firma inválida: no se guarda nada", async () => {
    const inbound = newInboundId();
    const res = await postWebhook(inboundPayload({ from: testPhone(), text: "Hola", id: inbound }), {
      signature: "sha256=" + "0".repeat(64),
    });
    expect(res.status).toBe(401);
    const { count } = await db()
      .from("inbound_messages")
      .select("id", { count: "exact", head: true })
      .eq("wa_message_id", inbound);
    expect(count).toBe(0);
  });
});
