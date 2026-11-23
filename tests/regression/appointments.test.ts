/**
 * Caracterización de recordatorios: altas, cambios de estado y mensaje de prueba.
 * R-01, R-02, R-14, R-16, R-17, R-20 (comportamiento de `main` @ f1ad32b).
 */
import { describe, expect, it, vi } from "vitest";
import { POST as createAppointmentRoute } from "@/app/api/appointments/route";
import { POST as testMessageRoute } from "@/app/api/messages/test/route";
import { createAppointmentAction, rescheduleAction, setStatusAction } from "@/app/panel/actions";
import { createAppointment } from "@/lib/appointments/service";
import { qstashFake } from "../fakes/qstash";
import { graphFake } from "../fakes/whatsapp";
import { adminAuth, hasDb, inDays, localDateTime, setupTestBusiness } from "../helpers/regression";
import { db, testPhone } from "../helpers/supabase-test";

// T-10.1: las acciones del panel toman el negocio de la sesión; aquí la sesión es de un owner del negocio de la prueba.
vi.mock("@/lib/auth/session", () => ({
  requireMember: vi.fn(async () => ({ id: null, userId: null, businessId: biz.current.id, role: "owner", displayName: "Prueba", legacy: true })),
}));

const biz = setupTestBusiness();
const REMINDER_KINDS = ["reminder_24h", "reminder_2h"];

const messagesOf = async (appointmentId: string) =>
  (
    await db()
      .from("messages")
      .select("kind, status, schedule_id, template_name, wa_message_id")
      .eq("appointment_id", appointmentId)
  ).data ?? [];

/** Turno a +3 días creado por el servicio, con sus dos recordatorios y sin enviar confirmación. */
async function createWithReminders(phone: string): Promise<string> {
  const { appointment } = await createAppointment({
    businessId: biz.current.id,
    customerName: "Cliente Prueba",
    customerPhone: phone,
    startsAt: inDays(3),
    service: "Corte",
    notify: false,
  });
  return appointment.id;
}

function formOf(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe.skipIf(!hasDb)("Regresión · turnos y recordatorios", () => {
  it("R-01 alta de turno por API", async () => {
    const phone = testPhone();
    const res = await createAppointmentRoute(
      new Request("http://localhost/api/appointments", {
        method: "POST",
        headers: { ...adminAuth(), "content-type": "application/json" },
        body: JSON.stringify({
          business_id: biz.current.id,
          customer: { name: "Ana Prueba", phone },
          starts_at: inDays(3).toISOString(),
          service: "Corte",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const { data: customer } = await db()
      .from("customers")
      .select("name, phone")
      .eq("business_id", biz.current.id)
      .eq("phone", phone)
      .single();
    expect(customer).toMatchObject({ name: "Ana Prueba", phone });

    const rows = await messagesOf(body.appointment.id);
    const queued = rows.filter((m) => m.status === "queued");
    expect(queued.map((m) => m.kind).sort()).toEqual(REMINDER_KINDS);
    expect(queued.every((m) => m.schedule_id?.startsWith("fake-schedule-"))).toBe(true);
    expect(qstashFake.scheduled).toHaveLength(2);

    expect(graphFake.templates()).toEqual(["appointment_confirmation_1"]);
    expect(rows.find((m) => m.kind === "confirmation")).toMatchObject({
      status: "accepted",
      template_name: "appointment_confirmation_1",
    });
  });

  it("R-02 alta de turno por el panel", async () => {
    const phone = testPhone();
    const local = localDateTime(inDays(3), biz.current.timezone);
    const result = await createAppointmentAction(
      null,
      formOf({
        businessId: biz.current.id,
        name: "Beto Prueba",
        countryCode: "",
        phone,
        date: local.date,
        time: local.time,
        service: "Barba",
        notes: "",
        notify: "on",
      }),
    );
    expect(result).toMatchObject({ ok: true, message: "Turno creado para Beto Prueba" });
    expect(result.warning).toBeUndefined();

    const rows = await messagesOf(result.id!);
    expect(rows.filter((m) => m.status === "queued").map((m) => m.kind).sort()).toEqual(REMINDER_KINDS);
    expect(rows.find((m) => m.kind === "confirmation")?.status).toBe("accepted");
    expect(graphFake.templates()).toEqual(["appointment_confirmation_1"]);
  });

  it("R-14 cancelar desde el panel", async () => {
    const id = await createWithReminders(testPhone());
    graphFake.reset();
    qstashFake.reset();

    const result = await setStatusAction(id, "cancelled");
    expect(result).toMatchObject({ ok: true, message: "Turno cancelado" });

    const rows = await messagesOf(id);
    expect(rows.filter((m) => REMINDER_KINDS.includes(m.kind)).every((m) => m.status === "cancelled")).toBe(true);
    expect(qstashFake.cancelled).toHaveLength(2);
    expect((await db().from("appointments").select("status").eq("id", id).single()).data?.status).toBe("cancelled");
    expect(graphFake.templates()).toEqual(["appointment_cancellation_1"]);
  });

  it("R-16 reprogramar", async () => {
    const id = await createWithReminders(testPhone());
    const oldSchedules = qstashFake.scheduled.map((s) => s.scheduleId);
    graphFake.reset();
    qstashFake.reset();

    const local = localDateTime(inDays(5), biz.current.timezone);
    const result = await rescheduleAction(
      null,
      formOf({ id, timeZone: biz.current.timezone, date: local.date, time: local.time, notify: "on" }),
    );
    expect(result).toMatchObject({ ok: true, message: "Turno reprogramado" });

    const rows = await messagesOf(id);
    expect(rows.filter((m) => m.status === "cancelled").map((m) => m.kind).sort()).toEqual(REMINDER_KINDS);
    expect(rows.filter((m) => m.status === "queued").map((m) => m.kind).sort()).toEqual(REMINDER_KINDS);
    expect([...qstashFake.cancelled].sort()).toEqual([...oldSchedules].sort());
    expect((await db().from("appointments").select("status").eq("id", id).single()).data?.status).toBe("rescheduled");
    expect(graphFake.templates()).toEqual(["appointment_confirmation_1"]);
  });

  it.each(["completed", "no_show"] as const)(
    "R-17 turno %s cancela los recordatorios pendientes",
    async (status) => {
      const id = await createWithReminders(testPhone());
      graphFake.reset();
      const result = await setStatusAction(id, status);
      expect(result.ok).toBe(true);
      const rows = await messagesOf(id);
      expect(rows.filter((m) => REMINDER_KINDS.includes(m.kind)).every((m) => m.status === "cancelled")).toBe(true);
      expect(graphFake.templates()).toEqual([]);
    },
  );

  it("R-20 mensaje de prueba", async () => {
    const to = testPhone();
    const res = await testMessageRoute(
      new Request("http://localhost/api/messages/test", {
        method: "POST",
        headers: { ...adminAuth(), "content-type": "application/json" },
        body: JSON.stringify({ to, nombre: "Ana", fecha: "lunes 1", hora: "10:00", negocio: "Prueba" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(graphFake.templates()).toEqual(["event_details_reminder_2"]);
    const { data } = await db().from("messages").select("kind, status, template_name").eq("to_phone", to).single();
    expect(data).toMatchObject({ kind: "test", status: "accepted", template_name: "event_details_reminder_2" });
  });
});
