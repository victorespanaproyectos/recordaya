/** T-12.4 · límites de consumo de 07 §19.10 (W-11, ingestas, zona de pruebas, respuestas del bot por día). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Member } from "@/lib/auth/session";
import { BOT_REPLIES_PER_DAY, createTurnDeps, RATE_LIMIT_PER_WINDOW } from "@/lib/chatbot/conversations/turn";
import { PLAYGROUND_MAX_TURNS_PER_DAY, runPlayground } from "@/lib/chatbot/engine/playground";
import { createSource, MAX_SOURCES_PER_DAY, MAX_UPLOAD_BYTES_PER_MONTH } from "@/lib/chatbot/rag/sources";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, testPhone, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
const MB = 1024 * 1024;

describe.skipIf(!hasDb)("T-12.4 · límites de consumo", () => {
  let biz: TestBusiness;
  let admin: Member;

  beforeAll(async () => {
    biz = await createTestBusiness();
    const { data } = await db().from("business_members").insert({ business_id: biz.id, email: `admin-${RUN_ID}@example.test`, display_name: "admin", role: "admin", status: "active" }).select("id").single();
    admin = { id: data!.id, userId: null, businessId: biz.id, role: "admin", displayName: "admin", legacy: false };
  }, 60_000);
  afterAll(async () => {
    await cleanup(biz?.id);
  }, 60_000);

  async function conversation() {
    const { data: contact } = await db().from("chat_contacts").insert({ business_id: biz.id, channel: "whatsapp", external_id: testPhone() }).select("id").single();
    const { data: conv } = await db().from("conversations").insert({ business_id: biz.id, contact_id: contact!.id, channel: "whatsapp", status: "bot" }).select("id").single();
    return conv!.id as string;
  }
  const ctxFor = (id: string) => ({ businessId: biz.id, conversation: { id } }) as never;
  const messages = (conversationId: string, n: number, direction: "inbound" | "outbound", sender: "customer" | "bot", at = new Date()) =>
    db().from("conversation_messages").insert(
      Array.from({ length: n }, (_, i) => ({
        conversation_id: conversationId, business_id: biz.id, direction, sender_type: sender, body: `m${i}`, status: direction === "inbound" ? "delivered" : "sent", created_at: new Date(at.getTime() + i).toISOString(),
      })),
    );

  it("W-11 · 20 mensajes en 10 min pasan; a partir del 21 hay un aviso y luego silencio", async () => {
    const id = await conversation();
    const deps = createTurnDeps();
    await messages(id, RATE_LIMIT_PER_WINDOW, "inbound", "customer");
    expect(await deps.rateLimit!(ctxFor(id))).toBe("ok");
    await messages(id, 5, "inbound", "customer"); // 25 en total
    expect(await deps.rateLimit!(ctxFor(id))).toBe("notify");
    expect(await deps.rateLimit!(ctxFor(id))).toBe("silent");
    expect((await db().from("conversation_events").select("id").eq("conversation_id", id).eq("type", "rate_limited")).data).toHaveLength(1);
  });

  it("el límite es por conversación: otro contacto no se ve afectado", async () => {
    const noisy = await conversation();
    const quiet = await conversation();
    await messages(noisy, 30, "inbound", "customer");
    expect(await createTurnDeps().rateLimit!(ctxFor(noisy))).toBe("notify");
    expect(await createTurnDeps().rateLimit!(ctxFor(quiet))).toBe("ok");
  });

  it("60 respuestas del bot en un día → aviso una vez y luego silencio; las de hace más de 24 h no cuentan", async () => {
    const id = await conversation();
    const longAgo = new Date(Date.now() - 30 * 3_600_000);
    await messages(id, BOT_REPLIES_PER_DAY, "outbound", "bot", longAgo);
    expect(await createTurnDeps().rateLimit!(ctxFor(id))).toBe("ok");

    await messages(id, BOT_REPLIES_PER_DAY, "outbound", "bot");
    const deps = createTurnDeps();
    expect(await deps.rateLimit!(ctxFor(id))).toBe("notify");
    expect(await deps.rateLimit!(ctxFor(id))).toBe("silent");
  });

  it("ingestas · la fuente número 51 en 24 h se rechaza (las eliminadas cuentan)", async () => {
    const rows = Array.from({ length: MAX_SOURCES_PER_DAY }, (_, i) => ({ business_id: biz.id, type: "text", title: `T${i}`, category: "other", body: "x", status: "ready", deleted_at: i % 2 ? new Date().toISOString() : null }));
    const { error } = await db().from("knowledge_sources").insert(rows);
    expect(error).toBeNull();
    await expect(createSource(biz.id, { type: "text", title: "Una más", body: "contenido" }, admin)).rejects.toThrow(/máximo de 50 fuentes por día/);
    await db().from("knowledge_sources").delete().eq("business_id", biz.id);
  });

  it("ingestas · pasar de 200 MB de archivos al mes se rechaza; por debajo se acepta", async () => {
    const { data: src } = await db().from("knowledge_sources").insert({ business_id: biz.id, type: "text", title: "base", category: "other", body: "x" }).select("id").single();
    const docs = Array.from({ length: 19 }, (_, i) => ({ source_id: src!.id, business_id: biz.id, version: i + 1, mime_type: "application/pdf", size_bytes: 10 * MB })); // 190 MB usados
    expect((await db().from("knowledge_documents").insert(docs)).error).toBeNull();
    const file = (sizeBytes: number) => ({ type: "file" as const, title: "Manual", storagePath: `${biz.id}/${crypto.randomUUID()}/manual.pdf`, mimeType: "application/pdf", sizeBytes });
    await expect(createSource(biz.id, file(10 * MB + 1), admin)).rejects.toThrow(/200 MB/);
    await expect(createSource(biz.id, file(10 * MB), admin)).resolves.toMatchObject({ type: "file" }); // justo el tope
    await expect(createSource(biz.id, file(1), admin)).rejects.toThrow(/200 MB/);
    expect(MAX_UPLOAD_BYTES_PER_MONTH).toBe(200 * MB);
    await db().from("knowledge_sources").delete().eq("business_id", biz.id);
  });

  it("zona de pruebas · el turno 101 del día se rechaza antes de llamar a la IA", async () => {
    await db().from("chatbot_usage").insert(
      Array.from({ length: PLAYGROUND_MAX_TURNS_PER_DAY }, () => ({ business_id: biz.id, operation: "playground", provider: "fake", model: "fake" })),
    );
    await expect(runPlayground(biz.id, [{ role: "user", text: "hola" }])).rejects.toThrow(/máximo de 100 pruebas por día/);
  });
});
