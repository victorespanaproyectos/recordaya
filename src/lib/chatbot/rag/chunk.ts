/** Fragmentación (04 §15.4). Funciones puras. `token_estimate = ceil(chars / 4)`. */

export const TARGET_CHARS = 2000; // ≈ 500 tokens
export const MAX_CORE_CHARS = 2400; // tope del texto propio de un fragmento
export const OVERLAP_CHARS = 300; // ≈ 15 % del objetivo
export const MAX_TOKENS = 800;
export const MAX_CHUNKS_PER_DOCUMENT = 2000;

const TITLE_MAX = 120;
const SECTION_MAX = 80;

export interface Chunk {
  index: number;
  /** Texto propio del fragmento (sin solapamiento ni prefijo): concatenarlos reconstruye el original. */
  text: string;
  /** Lo que se embebe y se muestra al modelo: prefijo de contexto + solapamiento + texto propio. */
  content: string;
  section: string | null;
  tokenEstimate: number;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Divide en secciones por líneas `## `, sin perder ni un carácter. */
function sections(text: string): { heading: string | null; text: string }[] {
  const starts = [...text.matchAll(/^## .*$/gm)].map((m) => m.index!);
  if (starts.length === 0) return [{ heading: null, text }];
  const bounds = starts[0] === 0 ? starts : [0, ...starts];
  return bounds
    .map((start, i) => {
      const part = text.slice(start, bounds[i + 1] ?? text.length);
      const m = /^## (.*)$/m.exec(part);
      return { heading: part.startsWith("## ") && m ? m[1].trim() : null, text: part };
    })
    .filter((s) => s.text.length > 0);
}

const PARAGRAPHS = /[\s\S]*?(?:\n{2,}|$)/g;
const SENTENCES = /[\s\S]*?(?:[.!?…]+(?=\s)\s*|\n|$)/g;
const WORDS = /\S+\s*/g;

const matches = (text: string, re: RegExp) => (text.match(re) ?? []).filter((s) => s.length > 0);

/** Parte `text` en trozos de a lo sumo `max` caracteres: párrafo → oración → palabra → corte duro. Sin perder caracteres. */
function pieces(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  for (const re of [PARAGRAPHS, SENTENCES, WORDS]) {
    const parts = matches(text, re);
    if (parts.length > 1) return parts.flatMap((p) => (p === text ? hardSplit(p, max) : pieces(p, max)));
  }
  return hardSplit(text, max);
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

/** Agrupa trozos hasta el tamaño objetivo. */
function pack(parts: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of parts) {
    if (current && current.length + part.length > TARGET_CHARS) {
      out.push(current);
      current = "";
    }
    current += part;
  }
  if (current) out.push(current);
  return out;
}

/** Últimos ≤ 300 caracteres del fragmento anterior, empezando en límite de palabra. */
function overlapOf(previous: string): string {
  if (previous.length <= OVERLAP_CHARS) return previous;
  const tail = previous.slice(-OVERLAP_CHARS);
  const space = tail.search(/\s/);
  return space === -1 ? tail : tail.slice(space).trimStart();
}

/** Fragmenta un texto normalizado. `title` es el título de la fuente (prefijo de contexto). */
export function chunkText(text: string, title: string): Chunk[] {
  const chunks: Chunk[] = [];
  for (const section of sections(text)) {
    const cores = pack(pieces(section.text, MAX_CORE_CHARS));
    cores.forEach((core, i) => {
      const prefix = `[${clip(title, TITLE_MAX)}]${section.heading ? ` › ${clip(section.heading, SECTION_MAX)}` : ""}\n`;
      // El solapamiento solo une fragmentos de la misma sección.
      const overlap = i > 0 ? overlapOf(cores[i - 1]) : "";
      chunks.push({
        index: chunks.length,
        text: core,
        content: `${prefix}${overlap ? `${overlap}\n` : ""}${core}`.trimEnd(),
        section: section.heading,
        tokenEstimate: 0,
      });
    });
  }
  for (const c of chunks) c.tokenEstimate = estimateTokens(c.content);
  return chunks;
}

/**
 * Una pregunta frecuente es un solo fragmento. Si no cabe en 800 tokens (respuesta muy larga), se fragmenta
 * como texto: el límite de tamaño tiene prioridad sobre "un fragmento por FAQ".
 */
export function chunkFaq(question: string, answer: string, title: string): Chunk[] {
  const body = `Pregunta: ${question}\nRespuesta: ${answer}`;
  const content = `[${clip(title, TITLE_MAX)}]\n${body}`;
  if (estimateTokens(content) <= MAX_TOKENS) {
    return [{ index: 0, text: body, content, section: null, tokenEstimate: estimateTokens(content) }];
  }
  return chunkText(body, title);
}
