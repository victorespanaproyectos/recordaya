/**
 * Caracterización de respuestas de clientes (modo con el chatbot DESACTIVADO).
 * R-06 … R-11 (comportamiento de `main` @ f1ad32b).
 *
 * Con el chatbot activo (Fase 8) R-09 y R-10 se reemplazan por W-08 y W-01: ver 09 §22.
 */
import { describe, expect, it } from "vitest";
import { qstashFake } from "../fakes/qstash";
import { graphFake } from "../fakes/whatsapp";
import { hasDb, inDays, setupTestBusiness } from "../helpers/regression";
import { createAppointment } from "@/lib/appointments/service";
import { db, insertAppointment, insertSentMessage, testPhone } from "../helpers/supabase-test";
import { inboundPayload, newInboundId, postWebhook } from "../helpers/webhook";

const biz = setupTestBusiness();

const appointmentRow = async (id: string) =>
  (await db().from("appointments").select("status").eq("id", id).single()).data!.status;

const inboundRows = async (wamid: string) =>
  (await db().from("inbound_messages").select("intent, appointment_id, body").eq("wa_message_id", wamid)).data ?? [];

/** Turno activo con un recordatorio "enviado" (citable) para el teléfono. */
async function activeAppointment(phone: string, startsInDays = 1) {
  const id = await insertAppointment({ businessId: biz.current.id, phone, startsAt: inDays(startsInDays) });
  const wamid = `wamid.TEST.REMINDER.${id}`;
  await insertSentMessage({ businessId: biz.current.id, appointmentId: id, phone, wamid });
  return { id, wamid };
}

describe.skipIf(!hasDb)("Regresión · respuestas de clientes (chatbot desactivado)", () => {
  it("R-06 confirmar citando el recordatorio", async () => {
    const phone = testPhone();
    const { id, wamid } = await activeAppointment(phone);
    const inbound = newInboundId();

    await postWebhook(inboundPayload({ from: phone, text: "1", id: inbound, contextId: wamid }));

    expect(await appointmentRow(id)).toBe("confirmed");
    expect(graphFake.texts()).toHaveLength(1);
    expect(graphFake.texts()[0]).toMatch(/¡Gracias, Cliente!.*quedó confirmado\. ✅/);
    expect(await inboundRows(inbound)).toEqual([{ intent: "confirm", appointment_id: id, body: "1" }]);
  });

  it("R-07 confirmar sin citar (próximo turno activo del teléfono)", async () => {
    const phone = testPhone();
    const { id } = await activeAppointment(phone);
    const inbound = newInboundId();

    await postWebhook(inboundPayload({ from: phone, text: "Sí", id: inbound }));

    expect(await appointmentRow(id)).toBe("confirmed");
    expect(graphFake.texts()[0]).toMatch(/quedó confirmado/);
    expect((await inboundRows(inbound))[0]).toMatchObject({ intent: "confirm", appointment_id: id });
  });

  it("R-08 cancelar citando: cancela recordatorios y avisa", async () => {
    const phone = testPhone();
    const { appointment } = await createAppointment({
      businessId: biz.current.id,
      customerName: "Cliente Prueba",
      customerPhone: phone,
      startsAt: inDays(3),
      notify: false,
    });
    const wamid = `wamid.TEST.REMINDER.${appointment.id}`;
    await insertSentMessage({ businessId: biz.current.id, appointmentId: appointment.id, phone, wamid });
    const scheduleIds = qstashFake.scheduled.map((s) => s.scheduleId);
    expect(scheduleIds).toHaveLength(2);

    await postWebhook(inboundPayload({ from: phone, text: "2", contextId: wamid }));

    expect(await appointmentRow(appointment.id)).toBe("cancelled");
    const { data: reminders } = await db()
      .from("messages")
      .select("kind, status")
      .eq("appointment_id", appointment.id)
      .in("kind", ["reminder_24h", "reminder_2h"]);
    expect(reminders!.filter((m) => m.status === "queued")).toEqual([]);
    expect(reminders!.filter((m) => m.status === "cancelled")).toHaveLength(2);
    expect([...qstashFake.cancelled].sort()).toEqual([...scheduleIds].sort());
    expect(graphFake.templates()).toEqual(["appointment_cancellation_1"]);
  });

  it("R-09 texto libre con turno activo → aviso «Responde 1 o 2»", async () => {
    const phone = testPhone();
    const { id } = await activeAppointment(phone);

    await postWebhook(inboundPayload({ from: phone, text: "¿Tienen estacionamiento?" }));

    expect(graphFake.texts()).toHaveLength(1);
    expect(graphFake.texts()[0]).toMatch(/Hola Cliente, tienes un turno el .* en Negocio de prueba/);
    expect(graphFake.texts()[0]).toContain("Responde *1* para confirmar o *2* para cancelar.");
    expect(await appointmentRow(id)).toBe("scheduled");
  });

  it("R-10 texto de un teléfono sin turnos → sin respuesta", async () => {
    const phone = testPhone();
    const inbound = newInboundId();

    await postWebhook(inboundPayload({ from: phone, text: "Hola", id: inbound }));

    expect(graphFake.calls).toHaveLength(0);
    expect(await inboundRows(inbound)).toEqual([{ intent: "unknown", appointment_id: null, body: "Hola" }]);
  });

  it("R-11 duplicado de Meta (mismo evento 3 veces) → 1 fila y 1 respuesta", async () => {
    const phone = testPhone();
    await activeAppointment(phone);
    const inbound = newInboundId();
    const payload = inboundPayload({ from: phone, text: "Hola", id: inbound });

    for (let i = 0; i < 3; i++) await postWebhook(payload);

    expect(await inboundRows(inbound)).toHaveLength(1);
    expect(graphFake.texts()).toHaveLength(1);
  });

  it("RI-02 (documentado) «No sé si abren el sábado» cancela el turno con el parser actual", async () => {
    const phone = testPhone();
    const { id } = await activeAppointment(phone);

    await postWebhook(inboundPayload({ from: phone, text: "No sé si abren el sábado" }));

    expect(await appointmentRow(id)).toBe("cancelled");
  });
});
