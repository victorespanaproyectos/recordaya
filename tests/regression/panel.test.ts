/**
 * Caracterización del acceso al panel y de sus datos.
 * R-15 (login actual con contraseña compartida) y R-18 (pendiente: necesita tablas del chatbot).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { loginAction } from "@/app/login/actions";
import { proxy } from "@/proxy";
import { getAgenda, getBusinesses, getRecentActivity, getStats } from "@/lib/panel/data";
import { createSessionToken, isValidSessionToken, SESSION_COOKIE } from "@/lib/panel/session-token";
import { hasDb, inDays, setupTestBusiness } from "../helpers/regression";
import { db, insertAppointment, testPhone } from "../helpers/supabase-test";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const biz = setupTestBusiness();
beforeEach(() => jar.clear());

const loginForm = (password: string, next?: string) => {
  const form = new FormData();
  form.set("password", password);
  if (next) form.set("next", next);
  return form;
};

describe("Regresión · R-15 acceso al panel (login legacy)", () => {
  it("contraseña incorrecta → error y sin cookie", async () => {
    const result = await loginAction({}, loginForm("incorrecta"));
    expect(result).toEqual({ error: "Contraseña incorrecta." });
    expect(jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("contraseña correcta → cookie de sesión válida y redirección a /panel", async () => {
    await expect(loginAction({}, loginForm(process.env.PANEL_PASSWORD!))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_REDIRECT;replace;/panel"),
    });
    expect(await isValidSessionToken(jar.get(SESSION_COOKIE))).toBe(true);
  });

  it("el parámetro next solo admite rutas internas del panel", async () => {
    await expect(loginAction({}, loginForm(process.env.PANEL_PASSWORD!, "//evil.test"))).rejects.toMatchObject({
      digest: expect.stringContaining(";/panel;"),
    });
  });

  it("el proxy deja pasar con sesión válida y redirige a /login sin ella", async () => {
    const token = await createSessionToken();
    const withSession = await proxy(
      new NextRequest("http://localhost:3000/panel", { headers: { cookie: `${SESSION_COOKIE}=${token}` } }),
    );
    expect(withSession.headers.get("x-middleware-next")).toBe("1");

    const without = await proxy(new NextRequest("http://localhost:3000/panel/turnos/x"));
    expect(without.status).toBe(307);
    expect(new URL(without.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(without.headers.get("location")!).searchParams.get("next")).toBe("/panel/turnos/x");
  });

  it.skipIf(!hasDb)("el panel carga agenda, métricas y actividad", async () => {
    const id = await insertAppointment({ businessId: biz.current.id, phone: testPhone(), startsAt: inDays(2) });

    const [businesses, agenda, stats, activity] = await Promise.all([
      getBusinesses(biz.current.id),
      getAgenda("upcoming", biz.current.id),
      getStats(biz.current.timezone, biz.current.id),
      getRecentActivity(biz.current.id),
    ]);

    expect(businesses.map((b) => b.id)).toContain(biz.current.id);
    expect(agenda.map((a) => a.id)).toContain(id);
    expect(stats).toEqual({
      today: expect.any(Number),
      next7Days: expect.any(Number),
      confirmationRate: expect.toBeOneOf([null, expect.any(Number)]),
      readRate: expect.toBeOneOf([null, expect.any(Number)]),
      sentLast7Days: expect.any(Number),
      pendingReminders: expect.any(Number),
    });
    expect(Array.isArray(activity)).toBe(true);
  });
});

describe.skipIf(!hasDb)("Regresión · R-18 métricas no contaminadas por el chatbot", () => {
  it("«Enviados 7 días», «Tasa de lectura» y «Pendientes» no cambian con 10 mensajes del bot", async () => {
    const before = await getStats(biz.current.timezone, biz.current.id);
    const { data: contact } = await db().from("chat_contacts").insert({ business_id: biz.current.id, channel: "whatsapp", external_id: testPhone() }).select("id").single();
    const { data: conv } = await db().from("conversations").insert({ business_id: biz.current.id, contact_id: contact!.id, channel: "whatsapp" }).select("id").single();
    await db().from("conversation_messages").insert(
      Array.from({ length: 10 }, (_, i) => ({
        conversation_id: conv!.id, business_id: biz.current.id, direction: "outbound", sender_type: "bot", body: `respuesta ${i}`, status: i % 2 ? "read" : "queued", wa_message_id: `wamid.TEST.R18.${conv!.id}.${i}`,
      })),
    );
    expect(await getStats(biz.current.timezone, biz.current.id)).toEqual(before);
  });
});
