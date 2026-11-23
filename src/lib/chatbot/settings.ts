import "server-only";
import { auditIpHash } from "@/lib/security/ip";
import { z } from "zod";
import { ServiceError } from "@/lib/appointments/service";
import { isAllowedModel } from "@/lib/chatbot/config";
import { WEEKDAYS } from "@/lib/chatbot/conversations/hours";
import { can, type Permission } from "@/lib/auth/permissions";
import type { Member } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Configuración del chatbot por negocio (tabla `chatbot_settings`, 03 §12.3).
 * Sin fila = chatbot desactivado con los valores por defecto de la migración.
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const timeRange = z.tuple([
  z.string().regex(TIME, "Las horas deben tener formato HH:MM (00:00 a 23:59)"),
  z.string().regex(TIME, "Las horas deben tener formato HH:MM (00:00 a 23:59)"),
]);

/** `human_hours`: franjas válidas (inicio < fin), sin solapes, y excepciones con fecha real y sin repetir. */
export const HumanHoursSchema = z
  .object({
    mon: z.array(timeRange).max(6).optional(),
    tue: z.array(timeRange).max(6).optional(),
    wed: z.array(timeRange).max(6).optional(),
    thu: z.array(timeRange).max(6).optional(),
    fri: z.array(timeRange).max(6).optional(),
    sat: z.array(timeRange).max(6).optional(),
    sun: z.array(timeRange).max(6).optional(),
    exceptions: z
      .array(
        z.object({
          date: z.string().regex(DATE, "La fecha de la excepción debe ser AAAA-MM-DD"),
          closed: z.literal(true),
        }).strict(),
      )
      .max(100)
      .optional(),
  })
  .strict()
  .superRefine((hours, ctx) => {
    for (const day of WEEKDAYS) {
      const ranges = [...(hours[day] ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
      ranges.forEach(([start, end], i) => {
        if (start >= end) ctx.addIssue({ code: "custom", message: `${day}: la hora de inicio (${start}) debe ser anterior al fin (${end})` });
        if (i > 0 && start < ranges[i - 1][1]) ctx.addIssue({ code: "custom", message: `${day}: las franjas se solapan` });
      });
    }
    const seen = new Set<string>();
    for (const { date } of hours.exceptions ?? []) {
      const real = !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
      if (!real) ctx.addIssue({ code: "custom", message: `La fecha ${date} no existe` });
      if (seen.has(date)) ctx.addIssue({ code: "custom", message: `La fecha ${date} está repetida en las excepciones` });
      seen.add(date);
    }
  });

const message = (label: string) =>
  z.string().trim().min(1, `${label} no puede estar vacío`).max(1000, `${label} admite hasta 1000 caracteres`);
/** Texto opcional: vacío se guarda como nulo. */
const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} admite hasta ${max} caracteres`)
    .nullable()
    .transform((v) => (v ? v : null));

const intRange = (label: string, min: number, max: number) =>
  z.number({ error: `${label} debe ser un número` }).int(`${label} debe ser un entero`).min(min, `${label} debe estar entre ${min} y ${max}`).max(max, `${label} debe estar entre ${min} y ${max}`);

/** Espejo de la tabla (solo columnas editables; el widget llega en otra fase). */
export const SettingsSchema = z
  .object({
    enabled: z.boolean(),
    assistant_name: z.string().trim().min(1, "El nombre del asistente no puede estar vacío").max(40, "El nombre del asistente admite hasta 40 caracteres"),
    business_description: optionalText("La descripción del negocio", 1000),
    tone: z.enum(["formal", "friendly", "neutral"], { error: "Tono inválido" }),
    personality: optionalText("La personalidad", 500),
    instructions: optionalText("Las instrucciones", 4000),
    language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Idioma inválido (ej. es, en, pt-BR)"),
    auto_language: z.boolean(),
    welcome_message: message("El mensaje de bienvenida"),
    handoff_offer_message: message("El mensaje de oferta de transferencia"),
    handoff_confirmed_message: message("El mensaje de transferencia confirmada"),
    out_of_hours_message: message("El mensaje fuera de horario"),
    no_info_message: message("El mensaje de sin información"),
    closing_message: optionalText("El mensaje de cierre", 1000),
    unsupported_content_message: message("El mensaje de contenido no soportado"),
    human_hours: HumanHoursSchema,
    max_answer_chars: intRange("La longitud máxima de respuesta", 200, 1500),
    offer_human_after_failures: intRange("Los fallos antes de ofrecer una persona", 1, 5),
    inactivity_close_hours: intRange("Las horas de inactividad para cerrar", 1, 168),
    answer_questions_on_reminder_replies: z.boolean(),
    confidence_threshold: z.number({ error: "El umbral de confianza debe ser un número" }).min(0, "El umbral de confianza debe estar entre 0 y 1").max(1, "El umbral de confianza debe estar entre 0 y 1"),
    llm_model: z.string().refine(isAllowedModel, "El modelo elegido no está permitido"),
    llm_effort: z.enum(["low", "medium", "high"], { error: "Esfuerzo inválido" }),
    monthly_budget_usd: z.number({ error: "El tope mensual debe ser un número" }).min(0, "El tope mensual no puede ser negativo").max(100000, "El tope mensual es demasiado alto"),
  })
  .strict();

export type ChatbotSettings = z.infer<typeof SettingsSchema>;
export type ChatbotSettingsPatch = Partial<z.input<typeof SettingsSchema>>;

/** Valores por defecto: los mismos que la migración 0006. */
export const DEFAULT_SETTINGS: ChatbotSettings = {
  enabled: false,
  assistant_name: "Asistente",
  business_description: null,
  tone: "friendly",
  personality: null,
  instructions: null,
  language: "es",
  auto_language: true,
  welcome_message: "¡Hola! Soy el asistente virtual de {negocio}. ¿En qué te ayudo?",
  handoff_offer_message: "¿Quieres que te atienda una persona del equipo?",
  handoff_confirmed_message: "Listo, te paso con una persona del equipo. Te responderán por aquí.",
  out_of_hours_message: "Ahora no hay nadie del equipo disponible. Te responderemos {proximo_horario}.",
  no_info_message: "No tengo esa información. Si quieres, te comunico con una persona del equipo.",
  closing_message: null,
  unsupported_content_message: "Por ahora solo puedo leer mensajes de texto.",
  human_hours: {},
  max_answer_chars: 700,
  offer_human_after_failures: 2,
  inactivity_close_hours: 24,
  answer_questions_on_reminder_replies: true,
  confidence_threshold: 0.6,
  llm_model: "default",
  llm_effort: "low",
  monthly_budget_usd: 20,
};

/** Campos que exigen un permiso más alto que `chatbot.configure` (06 §13.2: modelo y tope, solo owner). */
const OWNER_ONLY = ["llm_model", "llm_effort", "monthly_budget_usd"] as const;
const permissionFor = (field: string): Permission =>
  (OWNER_ONLY as readonly string[]).includes(field) ? "chatbot.model_and_budget" : "chatbot.configure";

const COLUMNS = Object.keys(DEFAULT_SETTINGS).join(", ");

function readableIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue.code === "unrecognized_keys") return `Campo desconocido: ${issue.keys.join(", ")}`;
  return issue.message;
}

type Row = Record<string, unknown>;

/** Normaliza lo que devuelve Postgres (numeric llega como número o texto según el driver). */
function fromRow(row: Row): ChatbotSettings {
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  out.confidence_threshold = Number(out.confidence_threshold);
  out.monthly_budget_usd = Number(out.monthly_budget_usd);
  return out as unknown as ChatbotSettings;
}

async function loadRow(businessId: string): Promise<Row | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("chatbot_settings")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as Row | null) ?? null;
}

/** Configuración del negocio; sin fila devuelve los valores por defecto (chatbot desactivado). */
export async function getChatbotSettings(businessId: string): Promise<ChatbotSettings> {
  const row = await loadRow(businessId);
  return row ? fromRow(row) : { ...DEFAULT_SETTINGS };
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Valida y guarda los campos indicados (crea la fila si no existe). Audita solo lo que cambió.
 * Admin: mensajes, horario, tono, comportamiento. Owner: además modelo, esfuerzo y tope mensual.
 */
export async function upsertChatbotSettings(
  businessId: string,
  patch: ChatbotSettingsPatch,
  member: Member,
): Promise<ChatbotSettings> {
  const parsed = SettingsSchema.partial().safeParse(patch);
  if (!parsed.success) throw new ServiceError(readableIssue(parsed.error));
  const changes = parsed.data as Record<string, unknown>;

  for (const field of Object.keys(changes)) {
    if (!can(member.role, permissionFor(field))) {
      throw new ServiceError(
        permissionFor(field) === "chatbot.model_and_budget"
          ? "Solo el owner puede cambiar el modelo, el esfuerzo y el tope mensual"
          : "No tienes permiso para cambiar la configuración",
        403,
      );
    }
  }

  const existing = await loadRow(businessId);
  const current = existing ? fromRow(existing) : { ...DEFAULT_SETTINGS };
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(changes)) {
    const from = (current as Record<string, unknown>)[field];
    if (!sameValue(from, to)) diff[field] = { from, to };
  }

  const db = getSupabaseAdmin();
  if (!existing) {
    const { error } = await db
      .from("chatbot_settings")
      .insert({ business_id: businessId, ...current, ...changes, updated_by: member.id });
    if (error) throw error;
  } else if (Object.keys(diff).length > 0) {
    const { error } = await db
      .from("chatbot_settings")
      .update({ ...Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.to])), updated_by: member.id })
      .eq("business_id", businessId);
    if (error) throw error;
  }

  if (!existing || Object.keys(diff).length > 0) {
    const { error } = await db.from("audit_log").insert({
      business_id: businessId,
      actor_member_id: member.id,
      action: "settings.updated",
      target_type: "chatbot_settings",
      target_id: businessId,
      diff: existing ? diff : { created: true, ...diff },
      ip_hash: await auditIpHash(),
    });
    if (error) throw error;
  }
  return { ...current, ...changes } as ChatbotSettings;
}

export { renderTemplate, type TemplateVars } from "@/lib/chatbot/template";
