import { z } from "zod";

/** Salida estructurada obligatoria del modelo (04 §14.3). */
export const BotOutput = z.object({
  intent: z.enum(["question", "smalltalk", "human_request", "appointment_action", "complaint", "out_of_scope", "unclear"]),
  /** Texto para el cliente. */
  answer: z.string().max(1500),
  /** ¿Toda afirmación factual sale de las fuentes o de los datos del negocio? */
  grounded: z.boolean(),
  /** Ids citados: "c1", "c2"… */
  used_source_ids: z.array(z.string()).max(8),
  confidence: z.number().min(0).max(1),
  needs_human: z.boolean(),
  needs_clarification: z.boolean(),
  /** Qué faltó (alimenta `unanswered_questions`). */
  missing_info: z.string().max(300).nullable(),
});
export type BotOutput = z.infer<typeof BotOutput>;

/** Resumen para el operador al derivar (T-07.5). */
export const SummaryOutput = z.object({ summary: z.string().max(600) });
export type SummaryOutput = z.infer<typeof SummaryOutput>;
