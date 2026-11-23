import "server-only";
import { ServiceError } from "@/lib/appointments/service";
import { can } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { createSource, type CATEGORIES } from "@/lib/chatbot/rag/sources";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/** Preguntas que el asistente no pudo responder (T-10.7): lista agrupada, «Crear FAQ» e «Ignorar». */

const db = () => getSupabaseAdmin();
const STOP = new Set(["que", "cual", "cuales", "como", "donde", "cuando", "cuanto", "cuanta", "cuantos", "por", "para", "con", "sin", "los", "las", "una", "uno", "unos", "unas", "del", "the", "hay", "son", "tienen", "tiene", "puedo", "pueden", "quiero", "saber", "hola", "buenas", "favor", "mas", "muy"]);

/** Palabras significativas de una pregunta: sin tildes, signos ni palabras vacías. */
export function significantTokens(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map((w) => (w.length > 4 ? w.replace(/(es|s)$/, "") : w)), // plural simple: «horarios» ≈ «horario»
    ),
  ];
}

const jaccard = (a: string[], b: string[]) => {
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
};

export interface UnansweredRow {
  id: string;
  question: string;
  reason: string;
  created_at: string;
}
export interface UnansweredGroup {
  /** Pregunta representativa (la más reciente del grupo). */
  question: string;
  ids: string[];
  count: number;
  lastAt: string;
  reasons: string[];
}

/** Agrupa preguntas parecidas (misma idea con otras palabras) para no revisar lo mismo muchas veces. */
export function groupQuestions(rows: UnansweredRow[], threshold = 0.6): UnansweredGroup[] {
  const groups: { tokens: string[]; group: UnansweredGroup }[] = [];
  for (const row of [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const tokens = significantTokens(row.question);
    const match = tokens.length > 0 ? groups.find((g) => (tokens.length === g.tokens.length && tokens.join() === g.tokens.join()) || jaccard(tokens, g.tokens) >= threshold) : undefined;
    if (match) {
      match.group.ids.push(row.id);
      match.group.count++;
      if (!match.group.reasons.includes(row.reason)) match.group.reasons.push(row.reason);
    } else {
      groups.push({ tokens, group: { question: row.question, ids: [row.id], count: 1, lastAt: row.created_at, reasons: [row.reason] } });
    }
  }
  return groups.map((g) => g.group).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

export async function listUnansweredGroups(businessId: string): Promise<UnansweredGroup[]> {
  const { data, error } = await db()
    .from("unanswered_questions")
    .select("id, question, reason, created_at")
    .eq("business_id", businessId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return groupQuestions(data ?? []);
}

function assertCanResolve(member: Member) {
  if (!can(member.role, "unanswered.resolve")) throw new ServiceError("No tienes permiso para resolver preguntas", 403);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cleanIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((i) => typeof i === "string" && UUID.test(i))) throw new ServiceError("Preguntas inválidas");
  return ids;
}

/** Marca como resueltas (o ignoradas) solo las abiertas del negocio del miembro. Devuelve cuántas cambió. */
async function close(member: Member, ids: string[], patch: Record<string, unknown>): Promise<number> {
  const { data, error } = await db()
    .from("unanswered_questions")
    .update({ ...patch, resolved_by: member.id, resolved_at: new Date().toISOString() })
    .in("id", ids)
    .eq("business_id", member.businessId)
    .eq("status", "open")
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

/** «Crear FAQ»: crea la fuente y resuelve todas las preguntas del grupo apuntando a ella (`resolved_source_id`). */
export async function resolveWithFaq(
  member: Member,
  ids: string[],
  faq: { title: string; question: string; answer: string; category?: (typeof CATEGORIES)[number] },
): Promise<{ sourceId: string; resolved: number }> {
  assertCanResolve(member);
  const clean = cleanIds(ids);
  const source = await createSource(member.businessId, { type: "faq", title: faq.title, question: faq.question, answer: faq.answer, category: faq.category }, member);
  const resolved = await close(member, clean, { status: "resolved", resolved_source_id: source.id });
  return { sourceId: source.id, resolved };
}

export async function ignoreQuestions(member: Member, ids: string[]): Promise<number> {
  assertCanResolve(member);
  return close(member, cleanIds(ids), { status: "ignored" });
}
