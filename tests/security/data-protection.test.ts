/**
 * S-02, S-06, S-09 y retención (T-12.6) contra la base de desarrollo.
 * Las partes que dependen de la migración 0012 se omiten (con aviso) si aún no está aplicada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasMinRole } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, testPhone, WEBHOOK_MARKER, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();
const state: { member: Member | null } = { member: null };
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  requireMember: async (min: Member["role"]) => {
    if (!state.member) throw new Error("NEXT_REDIRECT");
    if (!hasMinRole(state.member.role, min)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return state.member;
  },
}));

import { updateChatbotSettingsAction } from "@/app/panel/chatbot/actions";
import {
  createSourceAction, deleteSourceAction, ignoreUnansweredAction, resolveUnansweredWithFaqAction, setSourceEnabledAction, updateSourceAction,
} from "@/app/panel/conocimiento/actions";
import {
  claimConversationAction, closeConversationAction, declineHandoffAction, eraseContactDataAction, handoffConversationAction, markReadAction,
  reassignConversationAction, releaseConversationAction, resolveConversationAction, returnToBotAction, sendAgentMessageAction, sendReopenTemplateAction,
} from "@/app/panel/conversaciones/actions";
import { inviteMemberAction, updateMemberAction } from "@/app/panel/equipo/actions";
import { eraseContactData } from "@/lib/chatbot/conversations/erasure";
import { purgeExpired } from "@/lib/chatbot/conversations/maintenance";

async function migrated(): Promise<boolean> {
  if (!hasDb) return false;
  const { error } = await db().from("login_attempts").select("id").limit(1);
  if (error) console.warn("AVISO: la migración 0012 no está aplicada en la base de pruebas; se omiten S-09 y la retención (aplica supabase/apply/dev-0012.sql).");
  return !error;
}
const has0012 = await migrated();

type M = Member & { id: string };
const uuid = () => crypto.randomUUID();
const day = 86_400_000;

describe.skipIf(!hasDb)("S-02 · aislamiento y S-06 · permisos de las acciones del panel", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  const m: Record<string, M> = {};
  let conversationId: string;
  let sourceId: string;
  let questionId: string;

  async function member(biz: TestBusiness, role: Member["role"]): Promise<M> {
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: biz.id, email: `${role}-${biz.id.slice(0, 4)}-${RUN_ID}@example.test`, display_name: role, role, status: "active", is_available: true })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id, userId: null, businessId: biz.id, role, displayName: role, legacy: false };
  }

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    m.ownerA = await member(a, "owner");
    m.adminA = await member(a, "admin");
    m.operatorA = await member(a, "operator");
    m.ownerB = await member(b, "owner");
    m.adminB = await member(b, "admin");
    m.operatorB = await member(b, "operator");

    const { data: contact } = await db().from("chat_contacts").insert({ business_id: a.id, channel: "whatsapp", external_id: testPhone(), display_name: "Cliente A" }).select("id").single();
    const { data: conv } = await db().from("conversations").insert({ business_id: a.id, contact_id: contact!.id, channel: "whatsapp", status: "pending_human" }).select("id").single();
    conversationId = conv!.id;
    const { data: src, error } = await db().from("knowledge_sources").insert({ business_id: a.id, type: "faq", title: "Privada de A", category: "faq", faq_question: "¿q?", faq_answer: "secreto" }).select("id").single();
    if (error) throw error;
    sourceId = src!.id;
    const { data: q } = await db().from("unanswered_questions").insert({ business_id: a.id, conversation_id: conversationId, question: "¿pregunta de A?", reason: "no_context" }).select("id").single();
    questionId = q!.id;
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);
  beforeEach(() => {
    state.member = null;
  });

  const conversationState = async () => (await db().from("conversations").select("status, version, assigned_member_id").eq("id", conversationId).single()).data!;

  it("S-02 · un owner/admin de otro negocio no puede ejecutar ninguna acción sobre ids de A", async () => {
    const before = await conversationState();
    for (const who of [m.ownerB, m.adminB]) {
      state.member = who;
      const results: { ok: boolean }[] = [
        await claimConversationAction(conversationId),
        await releaseConversationAction(conversationId),
        await returnToBotAction(conversationId, true),
        await resolveConversationAction(conversationId, true),
        await closeConversationAction(conversationId),
        await handoffConversationAction(conversationId),
        await declineHandoffAction(conversationId),
        await reassignConversationAction(conversationId, m.operatorB.id),
        await markReadAction(conversationId),
        await sendAgentMessageAction(conversationId, "hola", uuid()),
        await sendReopenTemplateAction(conversationId, uuid()),
      ];
      if (who.role === "owner") results.push(await eraseContactDataAction(conversationId));
      for (const r of results) expect(r.ok, JSON.stringify(r)).toBe(false);
    }
    expect(await conversationState()).toEqual(before);
    expect((await db().from("chat_contacts").select("id").eq("business_id", a.id)).data).toHaveLength(1);
  });

  it("S-02 · fuentes, preguntas sin respuesta y miembros de A son intocables desde B", async () => {
    state.member = m.adminB;
    const form = new FormData();
    form.set("id", sourceId);
    form.set("title", "hack");
    for (const r of [await updateSourceAction(null, form), await setSourceEnabledAction(sourceId, false), await deleteSourceAction(sourceId)]) {
      expect(r.ok).toBe(false);
    }
    expect((await db().from("knowledge_sources").select("title, status, deleted_at").eq("id", sourceId).single()).data).toMatchObject({ title: "Privada de A", deleted_at: null });

    await resolveUnansweredWithFaqAction({ ids: [questionId], title: "FAQ", question: "¿q?", answer: "a" });
    await ignoreUnansweredAction([questionId]);
    expect((await db().from("unanswered_questions").select("status").eq("id", questionId).single()).data!.status).toBe("open");

    expect((await updateMemberAction(m.operatorA.id, { role: "owner" })).ok).toBe(false);
    expect((await db().from("business_members").select("role").eq("id", m.operatorA.id).single()).data!.role).toBe("operator");
  });

  it("S-06 · el operador de A es rechazado por el servidor en edición, configuración y equipo", async () => {
    state.member = m.operatorA;
    const f = new FormData();
    f.set("type", "faq");
    f.set("title", "x");
    const denied = (p: Promise<unknown>) => expect(p).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;403/);
    await denied(createSourceAction(null, f));
    await denied(updateSourceAction(null, f));
    await denied(setSourceEnabledAction(sourceId, false));
    await denied(deleteSourceAction(sourceId));
    await denied(resolveUnansweredWithFaqAction({ ids: [questionId], title: "t", question: "q", answer: "a" }));
    await denied(ignoreUnansweredAction([questionId]));
    await denied(updateChatbotSettingsAction(null, new FormData()));
    await denied(inviteMemberAction({ email: `nuevo-${RUN_ID}@example.test`, name: "Nuevo", role: "operator" }));
    await denied(updateMemberAction(m.adminA.id, { role: "operator" }));
    await denied(reassignConversationAction(conversationId, m.operatorA.id));
    await denied(eraseContactDataAction(conversationId));
    expect((await db().from("business_members").select("id").eq("business_id", a.id).eq("email", `nuevo-${RUN_ID}@example.test`)).data).toHaveLength(0);
  });

  it("S-06 · borrar datos de un contacto es solo del owner (admin y operador → 403)", async () => {
    state.member = m.adminA;
    await expect(eraseContactDataAction(conversationId)).rejects.toThrow(/403/);
    await expect(eraseContactData(m.adminA, conversationId)).rejects.toMatchObject({ status: 403 });
    await expect(eraseContactData(m.operatorA, conversationId)).rejects.toMatchObject({ status: 403 });
    expect((await db().from("chat_contacts").select("id").eq("business_id", a.id)).data).toHaveLength(1);
  });
});

describe.skipIf(!hasDb || !has0012)("S-09 · borrado de datos de un contacto y retención", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  let owner: M;
  const webhook = (phone: string, extra: Record<string, unknown> = {}) => ({ entry: [{ id: WEBHOOK_MARKER, ...extra, changes: [{ value: { messages: [{ from: phone }] } }] }] });

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    const { data } = await db().from("business_members").insert({ business_id: a.id, email: `owner-${RUN_ID}@example.test`, display_name: "owner", role: "owner", status: "active" }).select("id").single();
    owner = { id: data!.id, userId: null, businessId: a.id, role: "owner", displayName: "owner", legacy: false };
  }, 60_000);
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  }, 60_000);

  async function contactWithData(biz: TestBusiness, phone: string) {
    const { data: contact } = await db().from("chat_contacts").insert({ business_id: biz.id, channel: "whatsapp", external_id: phone, display_name: "Cliente" }).select("id").single();
    const { data: conv } = await db().from("conversations").insert({ business_id: biz.id, contact_id: contact!.id, channel: "whatsapp", status: "bot" }).select("id").single();
    await db().from("conversation_messages").insert({ conversation_id: conv!.id, business_id: biz.id, direction: "inbound", sender_type: "customer", body: "mi dato privado", status: "delivered" });
    await db().from("conversation_events").insert({ conversation_id: conv!.id, business_id: biz.id, type: "note", actor_type: "system" });
    await db().from("unanswered_questions").insert({ business_id: biz.id, conversation_id: conv!.id, question: "¿algo privado?", reason: "no_context" });
    await db().from("inbound_messages").insert({ wa_message_id: `wamid.TEST.IN.${RUN_ID}.${phone}`, from_phone: phone, type: "text", body: "hola", payload: {}, received_at: new Date().toISOString() });
    await db().from("webhook_events").insert({ payload: webhook(phone) });
    return { contactId: contact!.id as string, conversationId: conv!.id as string };
  }
  const rows = async (table: string, column: string, value: string) => (await db().from(table).select("id").eq(column, value)).data!.length;
  const left = async (phone: string, c: { contactId: string; conversationId: string }) => ({
    contact: await rows("chat_contacts", "id", c.contactId),
    conversation: await rows("conversations", "id", c.conversationId),
    messages: await rows("conversation_messages", "conversation_id", c.conversationId),
    events: await rows("conversation_events", "conversation_id", c.conversationId),
    unanswered: await rows("unanswered_questions", "conversation_id", c.conversationId),
    inbound: await rows("inbound_messages", "from_phone", phone),
  });
  const webhooksMentioning = async (phone: string) => {
    const { data } = await db().from("webhook_events").select("payload").contains("payload", { entry: [{ id: WEBHOOK_MARKER }] });
    return (data ?? []).filter((r) => JSON.stringify(r.payload).includes(`"${phone}"`)).length;
  };

  it("S-09 · el owner borra al contacto y desaparece todo lo suyo; el de otro contacto queda", async () => {
    const phone = testPhone();
    const other = testPhone();
    const mine = await contactWithData(a, phone);
    const theirs = await contactWithData(a, other);

    const result = await eraseContactData(owner, mine.conversationId);
    expect(result).toEqual({ conversations: 1, unanswered_questions: 1, inbound_messages: 1, webhook_events: 1 });

    expect(await left(phone, mine)).toEqual({ contact: 0, conversation: 0, messages: 0, events: 0, unanswered: 0, inbound: 0 });
    expect(await webhooksMentioning(phone)).toBe(0);

    expect(await left(other, theirs)).toEqual({ contact: 1, conversation: 1, messages: 1, events: 1, unanswered: 1, inbound: 1 });
    expect(await webhooksMentioning(other)).toBe(1);
  });

  it("S-09 · queda auditado sin teléfono ni contenido; un contacto de otro negocio no se toca (404)", async () => {
    const phone = testPhone();
    const mine = await contactWithData(a, phone);
    const foreign = await contactWithData(b, testPhone());
    await expect(eraseContactData(owner, foreign.conversationId)).rejects.toMatchObject({ status: 404 });
    expect(await rows("chat_contacts", "id", foreign.contactId)).toBe(1);

    await eraseContactData(owner, mine.conversationId);
    const { data } = await db().from("audit_log").select("action, diff, actor_member_id").eq("business_id", a.id).eq("action", "contact.erased").eq("target_id", mine.contactId);
    expect(data).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain(phone);
    expect(data![0].actor_member_id).toBe(owner.id);
  });

  it("retención · purga webhooks > 30 días y conversaciones/preguntas > 12 meses; lo reciente se conserva", async () => {
    const old = new Date(Date.now() - 31 * day).toISOString();
    const recent = new Date(Date.now() - 29 * day).toISOString();
    await db().from("webhook_events").insert([
      { payload: webhook("x", { tag: `viejo-${RUN_ID}` }), received_at: old },
      { payload: webhook("x", { tag: `reciente-${RUN_ID}` }), received_at: recent },
    ]);
    const stale = await contactWithData(a, testPhone());
    const fresh = await contactWithData(a, testPhone());
    await db().from("conversations").update({ last_message_at: new Date(Date.now() - 400 * day).toISOString() }).eq("id", stale.conversationId);
    await db().from("conversations").update({ last_message_at: new Date(Date.now() - 330 * day).toISOString() }).eq("id", fresh.conversationId);
    await db().from("unanswered_questions").insert({ business_id: a.id, question: `vieja ${RUN_ID}`, reason: "no_context", created_at: new Date(Date.now() - 400 * day).toISOString() });
    await db().from("login_attempts").insert([{ ip_hash: `t-${RUN_ID}`, attempted_at: new Date(Date.now() - 2 * day).toISOString() }, { ip_hash: `t-${RUN_ID}`, attempted_at: new Date().toISOString() }]);

    expect(await purgeExpired()).toBeGreaterThanOrEqual(4);

    expect(await rows("conversations", "id", stale.conversationId)).toBe(0);
    expect(await rows("conversation_messages", "conversation_id", stale.conversationId)).toBe(0);
    expect(await rows("conversations", "id", fresh.conversationId)).toBe(1);
    expect(await rows("unanswered_questions", "question", `vieja ${RUN_ID}`)).toBe(0);
    const { data: hooks } = await db().from("webhook_events").select("payload").contains("payload", { entry: [{ id: WEBHOOK_MARKER }] });
    const tags = (hooks ?? []).map((h) => JSON.stringify(h.payload));
    expect(tags.some((t) => t.includes(`viejo-${RUN_ID}`))).toBe(false);
    expect(tags.some((t) => t.includes(`reciente-${RUN_ID}`))).toBe(true);
    expect(await rows("login_attempts", "ip_hash", `t-${RUN_ID}`)).toBe(1);
    await db().from("login_attempts").delete().eq("ip_hash", `t-${RUN_ID}`);
  });
});
