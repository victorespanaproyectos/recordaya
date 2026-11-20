/**
 * Caracterización de recordatorios: envío, estados de entrega y dispatch.
 * R-03, R-04, R-05, R-19 (comportamiento de `main` @ f1ad32b).
 */
import { describe, expect, it } from "vitest";
import { POST as dispatchRoute } from "@/app/api/jobs/dispatch/route";
import { POST as sendReminderRoute } from "@/app/api/jobs/send-reminder/route";
import { createAppointment } from "@/lib/appointments/service";
import { qstashFake, VALID_QSTASH_SIGNATURE } from "../fakes/qstash";
import { graphFake } from "../fakes/whatsapp";
import { adminAuth, hasDb, inDays, setupTestBusiness } from "../helpers/regression";
import { db, insertAppointment, testPhone } from "../helpers/supabase-test";
import { postWebhook, statusPayload } from "../helpers/webhook";

const biz = setupTestBusiness();

async function appointmentWithReminders(phone: string) {
  const { appointment, reminders } = await createAppointment({
    businessId: biz.current.id,
    customerName: "Cliente Prueba",
    customerPhone: phone,
    startsAt: inDays(3),
    service: "Corte",
    notify: false,
  });
  return { id: appointment.id, reminder24h: reminders.find((r) => r.kind === "reminder_24h")!.id };
}

const runJob = (messageId: string, signature: string | null = VALID_QSTASH_SIGNATURE) =>
  sendReminderRoute(
    new Request("http://localhost/api/jobs/send-reminder", {
      method: "POST",
      headers: signature ? { "upstash-signature": signature } : {},
      body: JSON.stringify({ messageId }),
    }),
  );

const messageRow = async (id: string) =>
  (await db().from("messages").select("*").eq("id", id).single()).data!;

describe.skipIf(!hasDb)("Regresión · envío de recordatorios", () => {
  it("R-03 envío de recordatorio", async () => {
    const { reminder24h } = await appointmentWithReminders(testPhone());

    const res = await runJob(reminder24h);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "sent" });

    expect(graphFake.templates()).toEqual(["event_details_reminder_2"]);
    const row = await messageRow(reminder24h);
    expect(row).toMatchObject({ status: "accepted", template_name: "event_details_reminder_2" });
    expect(row.wa_message_id).toBe(graphFake.lastWamid);
  });

  it("R-03 firma de QStash inválida → 401 y no se envía nada", async () => {
    const { reminder24h } = await appointmentWithReminders(testPhone());
    const res = await runJob(reminder24h, "firma-falsa");
    expect(res.status).toBe(401);
    expect(graphFake.calls).toHaveLength(0);
    expect((await messageRow(reminder24h)).status).toBe("queued");
  });

  it("R-04 estados de entrega: avanzan y nunca retroceden", async () => {
    const phone = testPhone();
    const { reminder24h } = await appointmentWithReminders(phone);
    await runJob(reminder24h);
    const wamid = graphFake.lastWamid;

    for (const status of ["sent", "delivered", "read"] as const) {
      await postWebhook(statusPayload(wamid, status, phone));
    }
    let row = await messageRow(reminder24h);
    expect(row.status).toBe("read");
    expect(row.read_at).not.toBeNull();
    const readAt = row.read_at;

    // "delivered" tardío: no retrocede
    await postWebhook(statusPayload(wamid, "delivered", phone));
    row = await messageRow(reminder24h);
    expect(row.status).toBe("read");
    expect(row.read_at).toBe(readAt);
  });

  it("R-05 recordatorio a turno confirmado usa la plantilla de turno confirmado", async () => {
    const phone = testPhone();
    const { id, reminder24h } = await appointmentWithReminders(phone);
    await db().from("appointments").update({ status: "confirmed" }).eq("id", id);

    await runJob(reminder24h);
    expect(graphFake.templates()).toEqual(["event_details_reminder_1"]);
  });

  it("R-19 dispatch programa recordatorios pendientes sin schedule_id", async (ctx) => {
    // El dispatch actúa sobre TODA la base: si hay otros pendientes ajenos a esta prueba, no se corre.
    const { count } = await db()
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued")
      .is("schedule_id", null)
      .not("scheduled_for", "is", null);
    if ((count ?? 0) > 0) ctx.skip("Hay recordatorios pendientes ajenos a la prueba en esta base");

    const phone = testPhone();
    const apptId = await insertAppointment({ businessId: biz.current.id, phone, startsAt: inDays(2) });
    const { data: msg } = await db()
      .from("messages")
      .insert({
        business_id: biz.current.id,
        appointment_id: apptId,
        to_phone: phone,
        kind: "reminder_24h",
        template_name: "event_details_reminder_2",
        status: "queued",
        scheduled_for: inDays(0, 1).toISOString(),
      })
      .select("id")
      .single();

    const res = await dispatchRoute(
      new Request("http://localhost/api/jobs/dispatch", { method: "POST", headers: adminAuth() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pending: 1, scheduled: 1, failures: [] });
    expect(qstashFake.scheduled.map((s) => s.messageId)).toEqual([msg!.id]);
    expect((await messageRow(msg!.id)).schedule_id).toBe(qstashFake.scheduled[0].scheduleId);
  });
});
