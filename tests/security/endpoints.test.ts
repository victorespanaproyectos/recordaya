/**
 * S-07, S-08, S-11 (09 §Pruebas de seguridad): ningún endpoint de servidor responde sin credenciales válidas.
 * No necesitan base de datos: la comprobación ocurre antes de tocar nada.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getCurrentMember: async () => null, requireMember: async () => { throw new Error("NEXT_REDIRECT"); } }));

import { POST as chatbotReply } from "@/app/api/jobs/chatbot-reply/route";
import { POST as dispatch } from "@/app/api/jobs/dispatch/route";
import { POST as knowledgeIngest } from "@/app/api/jobs/knowledge-ingest/route";
import { POST as maintenance } from "@/app/api/jobs/conversations-maintenance/route";
import { POST as sendReminder } from "@/app/api/jobs/send-reminder/route";
import { GET as inbox } from "@/app/api/panel/inbox/route";
import { GET as messagesGet, POST as messagesPost } from "@/app/api/panel/conversations/[id]/messages/route";
import { POST as appointmentsPost } from "@/app/api/appointments/route";
import { config as proxyConfig } from "@/proxy";

const ID = "00000000-0000-4000-8000-000000000001";
const post = (headers: Record<string, string> = {}, body = "{}") =>
  new Request("http://localhost/api/x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("S-08 · jobs sin firma de QStash", () => {
  const jobs = {
    "chatbot-reply": chatbotReply,
    "knowledge-ingest": knowledgeIngest,
    "send-reminder": sendReminder,
  };
  for (const [name, handler] of Object.entries(jobs)) {
    it(`${name}: sin firma → 401 y con firma falsa → 401`, async () => {
      expect((await handler(post())).status).toBe(401);
      expect((await handler(post({ "upstash-signature": "falsa" }))).status).toBe(401);
    });
  }
  const dualAuth = { "conversations-maintenance": maintenance, dispatch };
  for (const [name, handler] of Object.entries(dualAuth)) {
    it(`${name}: sin firma ni clave → 401; clave incorrecta → 401`, async () => {
      expect((await handler(post())).status).toBe(401);
      expect((await handler(post({ authorization: "Bearer otra-clave" }))).status).toBe(401);
      expect((await handler(post({ authorization: "test-admin-key" }))).status).toBe(401); // sin el prefijo Bearer
    });
  }
});

describe("S-11 · sin sesión", () => {
  it("las APIs del panel responden 401", async () => {
    expect((await inbox()).status).toBe(401);
    expect((await messagesGet(new Request("http://localhost/x"), { params: Promise.resolve({ id: ID }) } as never)).status).toBe(401);
    const res = await messagesPost(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: ID }) } as never);
    expect(res.status).toBe(401);
  });
  it("la API de turnos exige la clave de administración", async () => {
    expect((await appointmentsPost(post())).status).toBe(401);
  });
  it("el proxy protege todo /panel (incluye conversaciones, conocimiento, chatbot y equipo)", () => {
    expect(proxyConfig.matcher).toEqual(["/panel/:path*"]);
  });
});
