/**
 * Pruebas de las migraciones 0005–0011 (T-03.1): objetos, toma concurrente y aislamiento de la búsqueda.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();

/** Vector de 1024 dimensiones con un valor dominante en `axis`: distintos ejes = textos "distintos". */
const vec = (axis: number) => `[${Array.from({ length: 1024 }, (_, i) => (i === axis ? 1 : 0.001)).join(",")}]`;

const TABLES = [
  "business_members", "chatbot_settings", "audit_log", "knowledge_sources", "knowledge_documents",
  "knowledge_chunks", "chat_contacts", "conversations", "conversation_messages",
  "conversation_assignments", "conversation_events", "chatbot_usage", "unanswered_questions",
  "chatbot_usage_monthly",
];

describe.skipIf(!hasDb)("Migraciones del chatbot", () => {
  let a: TestBusiness;
  let b: TestBusiness;

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
  });
  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
  });

  it("existen todas las tablas, la vista y la columna nueva de businesses", async () => {
    for (const table of TABLES) {
      const { error } = await db().from(table).select("*", { head: true, count: "exact" });
      expect(error, table).toBeNull();
    }
    const { error } = await db().from("businesses").select("wa_phone_number_id").limit(1);
    expect(error).toBeNull();
  });

  it("existe el bucket privado «knowledge»", async () => {
    const { data, error } = await db().storage.getBucket("knowledge");
    expect(error).toBeNull();
    expect(data).toMatchObject({ id: "knowledge", public: false, file_size_limit: 10485760 });
  });

  it("chatbot_settings nace desactivado y con el modelo 'default' (D-03 revisada)", async () => {
    const { data, error } = await db().from("chatbot_settings").insert({ business_id: a.id }).select().single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ enabled: false, llm_model: "default", llm_effort: "low", max_answer_chars: 700 });
  });

  it("conversations: una sola abierta por contacto y canal; 'human' exige operador", async () => {
    const { data: contact } = await db()
      .from("chat_contacts").insert({ business_id: a.id, channel: "whatsapp", external_id: "59890000001" })
      .select("id").single();
    const base = { business_id: a.id, contact_id: contact!.id, channel: "whatsapp" };

    expect((await db().from("conversations").insert(base)).error).toBeNull();
    expect((await db().from("conversations").insert(base)).error?.code).toBe("23505");
    expect((await db().from("conversations").insert({ ...base, contact_id: contact!.id, status: "human" })).error).not.toBeNull();
  });

  it("claim_conversation: con 2 operadores en paralelo gana exactamente uno (10 repeticiones)", async () => {
    const members = await Promise.all(
      ["op1", "op2"].map(async (n) =>
        (await db().from("business_members")
          .insert({ business_id: a.id, email: `${n}@example.test`, display_name: n, role: "operator", status: "active" })
          .select("id").single()).data!.id as string),
    );

    for (let i = 0; i < 10; i++) {
      const { data: contact } = await db()
        .from("chat_contacts").insert({ business_id: a.id, channel: "whatsapp", external_id: `5989000${100 + i}` })
        .select("id").single();
      const { data: conv } = await db()
        .from("conversations")
        .insert({ business_id: a.id, contact_id: contact!.id, channel: "whatsapp", status: "pending_human" })
        .select("id").single();

      const results = await Promise.all(
        members.map((m) => db().rpc("claim_conversation", { p_conversation_id: conv!.id, p_business_id: a.id, p_member_id: m })),
      );
      expect(results.every((r) => r.error === null)).toBe(true);
      expect(results.filter((r) => r.data === true)).toHaveLength(1);

      const { count } = await db().from("conversation_assignments")
        .select("id", { count: "exact", head: true }).eq("conversation_id", conv!.id).is("released_at", null);
      expect(count).toBe(1);
    }
  });

  it("claim_conversation no actúa sobre otro negocio", async () => {
    const { data: member } = await db().from("business_members")
      .insert({ business_id: b.id, email: "opb@example.test", display_name: "opb", role: "operator", status: "active" })
      .select("id").single();
    const { data: contact } = await db().from("chat_contacts")
      .insert({ business_id: a.id, channel: "whatsapp", external_id: "59890000999" }).select("id").single();
    const { data: conv } = await db().from("conversations")
      .insert({ business_id: a.id, contact_id: contact!.id, channel: "whatsapp", status: "pending_human" })
      .select("id").single();

    const { data } = await db().rpc("claim_conversation", { p_conversation_id: conv!.id, p_business_id: b.id, p_member_id: member!.id });
    expect(data).toBe(false);
  });

  it("try_lock_conversation: el segundo intento falla hasta unlock", async () => {
    const { data: contact } = await db().from("chat_contacts")
      .insert({ business_id: a.id, channel: "whatsapp", external_id: "59890000888" }).select("id").single();
    const { data: conv } = await db().from("conversations")
      .insert({ business_id: a.id, contact_id: contact!.id, channel: "whatsapp" }).select("id").single();

    expect((await db().rpc("try_lock_conversation", { p_conversation_id: conv!.id })).data).toBe(true);
    expect((await db().rpc("try_lock_conversation", { p_conversation_id: conv!.id })).data).toBe(false);
    await db().rpc("unlock_conversation", { p_conversation_id: conv!.id });
    expect((await db().rpc("try_lock_conversation", { p_conversation_id: conv!.id })).data).toBe(true);
  });

  /** Fuente FAQ lista con 1 fragmento, activada con activate_knowledge_document. */
  async function readyFaq(business: TestBusiness, question: string, answer: string, axis: number) {
    const { data: source } = await db().from("knowledge_sources")
      .insert({ business_id: business.id, type: "faq", title: question, faq_question: question, faq_answer: answer })
      .select("id").single();
    const { data: doc } = await db().from("knowledge_documents")
      .insert({ source_id: source!.id, business_id: business.id, version: 1 }).select("id").single();
    const { error } = await db().from("knowledge_chunks").insert({
      business_id: business.id, source_id: source!.id, document_id: doc!.id, chunk_index: 0,
      content: `${question} ${answer}`, token_estimate: 10, embedding: vec(axis),
    });
    expect(error).toBeNull();
    expect((await db().rpc("activate_knowledge_document", { p_document_id: doc!.id })).error).toBeNull();
    return { sourceId: source!.id as string, documentId: doc!.id as string };
  }

  const search = (business: TestBusiness, axis: number, text: string) =>
    db().rpc("match_knowledge_chunks", { p_business_id: business.id, p_query_embedding: vec(axis), p_query_text: text });

  it("match_knowledge_chunks: cada negocio ve solo su conocimiento (S-04)", async () => {
    await readyFaq(a, "¿Cuánto sale el corte?", "El corte sale 400 pesos.", 5);
    await readyFaq(b, "¿Cuánto sale el corte?", "El corte sale 700 pesos.", 5);

    const ra = await search(a, 5, "cuánto sale el corte");
    const rb = await search(b, 5, "cuánto sale el corte");
    expect(ra.error).toBeNull();
    expect(ra.data).toHaveLength(1);
    expect(ra.data[0].content).toContain("400");
    expect(rb.data).toHaveLength(1);
    expect(rb.data[0].content).toContain("700");
  });

  it("una versión nueva no deja huecos y al activarse purga los fragmentos de la anterior (F-10)", async () => {
    const { sourceId, documentId: v1 } = await readyFaq(a, "Horario", "Abrimos de 9 a 18.", 9);

    // v2 en proceso: la v1 sigue respondiendo.
    const { data: v2 } = await db().from("knowledge_documents")
      .insert({ source_id: sourceId, business_id: a.id, version: 2 }).select("id").single();
    expect((await search(a, 9, "horario")).data.some((r: { content: string }) => r.content.includes("9 a 18"))).toBe(true);

    await db().from("knowledge_chunks").insert({
      business_id: a.id, source_id: sourceId, document_id: v2!.id, chunk_index: 0,
      content: "Horario Abrimos de 10 a 19.", token_estimate: 10, embedding: vec(9),
    });
    await db().rpc("activate_knowledge_document", { p_document_id: v2!.id });

    const after = (await search(a, 9, "horario")).data as { content: string }[];
    expect(after.some((r) => r.content.includes("10 a 19"))).toBe(true);
    expect(after.some((r) => r.content.includes("9 a 18"))).toBe(false);
    const { count } = await db().from("knowledge_chunks").select("id", { count: "exact", head: true }).eq("document_id", v1);
    expect(count).toBe(0);
  });

  it("una fuente desactivada o eliminada deja de responder (F-11, F-12)", async () => {
    const { sourceId } = await readyFaq(a, "Estacionamiento", "Hay estacionamiento gratis.", 13);
    expect((await search(a, 13, "estacionamiento")).data).toHaveLength(1);

    await db().from("knowledge_sources").update({ status: "disabled" }).eq("id", sourceId);
    expect((await search(a, 13, "estacionamiento")).data).toHaveLength(0);

    await db().from("knowledge_sources").update({ status: "ready", deleted_at: new Date().toISOString() }).eq("id", sourceId);
    expect((await search(a, 13, "estacionamiento")).data).toHaveLength(0);
  });
});
