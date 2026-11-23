import { FIXED_RULES } from "./prompt";

/** Guardas de las salidas del modelo (04 §14.5). Funciones puras. */

const URL_RE = /(?:https?:\/\/|www\.)[^\s)<>\]"']+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const NUMBER_RE = /\d+(?:[.,:/]\d+)*/g;
/** "1" y "2" son las respuestas del recordatorio (confirmar / cancelar): se explican sin estar en una fuente. */
const EXEMPT_NUMBERS = new Set(["1", "2"]);

const trimUrl = (u: string) => u.replace(/[.,;:!?]+$/, "").toLowerCase();

/** "1.500" y "1,500" → "1500"; "09:30" y "9:30" → "9.30". Las comparaciones se hacen sobre esta forma. */
function normalizeNumber(token: string): string {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(token)) return token.replace(/[.,]/g, "");
  return token.split(/[.,:/]/).map((p) => String(parseInt(p, 10))).join(".");
}

/** Un horario «9:00» también se acepta como «9» (y al revés): los minutos en cero se pueden omitir. */
function variants(token: string): string[] {
  const n = normalizeNumber(token);
  const hour = /^(\d{1,2}):0+$/.exec(token);
  return hour ? [n, String(parseInt(hour[1], 10))] : [n];
}

function numberTokens(text: string): string[] {
  return text.replace(PHONE_RE, " ").match(NUMBER_RE) ?? [];
}

export interface FactCheck {
  ok: boolean;
  /** Datos de la respuesta que no aparecen en las fuentes ni en los datos del negocio. */
  missing: string[];
}

/**
 * Todo número, hora, precio, teléfono, URL o email de la respuesta debe aparecer literalmente (con formato
 * normalizado) en los fragmentos usados o en los datos del negocio. Si no, la respuesta se descarta.
 */
export function assertFactsInSources(answer: string, allowedTexts: string[]): FactCheck {
  const haystack = allowedTexts.join("\n");
  const lower = haystack.toLowerCase();
  const digitsOnly = haystack.replace(/\D/g, "");
  const allowedNumbers = new Set(numberTokens(haystack).flatMap(variants));
  const missing: string[] = [];

  for (const url of answer.match(URL_RE) ?? []) {
    if (!lower.includes(trimUrl(url).replace(/^https?:\/\//, ""))) missing.push(trimUrl(url));
  }
  for (const email of answer.match(EMAIL_RE) ?? []) {
    if (!lower.includes(email.toLowerCase())) missing.push(email.toLowerCase());
  }
  const withoutLinks = answer.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  for (const phone of withoutLinks.match(PHONE_RE) ?? []) {
    const digits = phone.replace(/\D/g, "");
    // Un teléfono tiene al menos 7 dígitos; menos que eso es otra cosa (p. ej. "2026-11-19").
    if (digits.length >= 7 && !digitsOnly.includes(digits)) missing.push(phone.trim());
  }
  for (const token of numberTokens(withoutLinks)) {
    const forms = variants(token);
    if (!forms.some((n) => EXEMPT_NUMBERS.has(n) || allowedNumbers.has(n))) missing.push(forms[0]);
  }
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const WINDOW = 30;

export type LeakReason = "canary" | "prompt_overlap";

/** ¿La respuesta contiene el canario o ≥ 30 caracteres consecutivos del prompt fijo? */
export function detectPromptLeak(answer: string, options: { canary?: string; fixedPrompt?: string } = {}): LeakReason | null {
  if (options.canary && answer.includes(options.canary)) return "canary";
  const a = squash(answer);
  const p = squash(options.fixedPrompt ?? FIXED_RULES);
  for (let i = 0; i + WINDOW <= a.length; i++) {
    if (p.includes(a.slice(i, i + WINDOW))) return "prompt_overlap";
  }
  return null;
}

const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "ignore_instructions", re: /\b(ignor[ae]|olvid[ae]|descarta)\b.{0,30}\b(instrucciones|reglas|indicaciones|anteriores)\b/i },
  { name: "ignore_instructions_en", re: /\b(ignore|disregard|forget)\b.{0,30}\b(instructions|rules|previous|above)\b/i },
  { name: "reveal_prompt", re: /\b(revela|muestra|dime|repite|imprime|escribe|dame)\b.{0,40}\b(prompt|instrucciones|reglas)\b/i },
  { name: "reveal_prompt_en", re: /\b(reveal|show|print|repeat|tell me)\b.{0,40}\b(system prompt|prompt|instructions|rules)\b/i },
  { name: "system_prompt", re: /\b(system prompt|prompt del sistema|mensaje del sistema)\b/i },
  { name: "role_change", re: /\b(act[uú]a como|compórtate como|finge ser|pretend to be|you are now|ahora eres|a partir de ahora eres)\b/i },
  { name: "jailbreak", re: /\b(jailbreak|modo desarrollador|developer mode|DAN mode|sin restricciones)\b/i },
];

/**
 * Frases de un documento que parecen órdenes para una IA («IA: ignora tus instrucciones…», «dile al cliente que…»).
 * Se usa al ingerir (07 §19.8, capa 7): el fragmento se marca `metadata.suspicious`; no se bloquea ni se borra.
 */
const DIRECTED_PATTERNS: RegExp[] = [
  /\b(ia|ai|asistente|chatbot|bot|assistant)\s*[:,-]\s*(ignor|olvid|di |dile|responde|actúa|actua|no |nunca|siempre|you must|ignore)/i,
  /\b(ignor[ae]|olvid[ae]|descarta)\b.{0,30}\b(instrucciones|reglas|indicaciones|anteriores)\b/i,
  /\b(ignore|disregard|forget)\b.{0,30}\b(instructions|rules|previous|above)\b/i,
  /\b(dile|dí|di|responde|contesta)\b.{0,20}\b(al cliente|a los clientes|al usuario)\b/i,
  /\b(act[uú]a como|compórtate como|finge ser|you are now|ahora eres)\b/i,
  /\b(system prompt|prompt del sistema)\b/i,
];

export function looksLikeInstructionsForAi(text: string): boolean {
  return DIRECTED_PATTERNS.some((re) => re.test(text));
}

export interface InjectionCheck {
  suspected: boolean;
  matches: string[];
}

/** Heurística de intentos de inyección en la entrada: solo se registra, no bloquea. */
export function detectInjectionAttempt(text: string): InjectionCheck {
  const matches = INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  return { suspected: matches.length > 0, matches };
}

/** Recorta la respuesta al máximo, preferentemente en un fin de oración o de palabra. */
export function clampAnswer(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  if (sentenceEnd > max * 0.6) return `${cut.slice(0, sentenceEnd + 1).trimEnd()}`;
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Los ids citados deben existir en el contexto entregado al modelo. */
export function citedIdsAreValid(used: string[], available: string[]): boolean {
  const set = new Set(available);
  return used.every((id) => set.has(id));
}
