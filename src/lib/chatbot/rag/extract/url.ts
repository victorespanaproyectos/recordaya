import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { ExtractionError } from "./errors";
import { assertPublicUrl, type Resolver } from "./ssrf";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const USER_AGENT = "RecordaYaBot/1.0";

type Fetcher = typeof fetch;
export interface UrlOptions {
  fetcher?: Fetcher;
  resolver?: Resolver;
}

/** Descarga limitada: sigue redirecciones a mano, validando cada destino contra SSRF. */
async function fetchPublic(raw: string, accept: string, opts: UrlOptions): Promise<Response> {
  const fetcher = opts.fetcher ?? fetch;
  let url = await assertPublicUrl(raw, opts.resolver);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetcher(url, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ExtractionError("No se pudo abrir la página (sin respuesta a tiempo)");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new ExtractionError("La página redirige sin destino");
      url = await assertPublicUrl(new URL(location, url).toString(), opts.resolver);
      continue;
    }
    return res;
  }
  throw new ExtractionError("La página redirige demasiadas veces");
}

/** Lee el cuerpo hasta `MAX_BYTES`; si lo supera, aborta. */
async function readLimited(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) throw new ExtractionError("La página pesa más de 2 MB");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new ExtractionError("La página pesa más de 2 MB");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** ¿robots.txt prohíbe a RecordaYaBot (o a todos) leer esta ruta? Si no se puede leer robots.txt, se permite. */
export function robotsDisallows(robots: string, path: string): boolean {
  let applies = false;
  let specific = false;
  const rules: { specific: boolean; allow: boolean; prefix: string }[] = [];
  let inGroup = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!inGroup) {
        applies = false;
        specific = false;
      }
      inGroup = true;
      const agent = value.toLowerCase();
      if (agent === "*" || agent === "recordayabot") {
        applies = true;
        specific = specific || agent === "recordayabot";
      }
    } else if (key === "disallow" || key === "allow") {
      inGroup = false;
      if (applies && value) rules.push({ specific, allow: key === "allow", prefix: value });
    }
  }
  const useSpecific = rules.some((r) => r.specific);
  const relevant = rules.filter((r) => r.specific === useSpecific && path.startsWith(r.prefix.replace(/\*$/, "")));
  if (relevant.length === 0) return false;
  const best = relevant.reduce((a, b) => (b.prefix.length >= a.prefix.length ? b : a));
  return !best.allow;
}

/** Texto principal de una página web pública. */
export async function extractUrl(raw: string, opts: UrlOptions = {}): Promise<{ text: string; title: string | null }> {
  const url = await assertPublicUrl(raw, opts.resolver);

  try {
    const robots = await fetchPublic(new URL("/robots.txt", url).toString(), "text/plain", opts);
    if (robots.ok && robotsDisallows(await readLimited(robots), url.pathname + url.search)) {
      throw new ExtractionError("El sitio no permite que se lea esta página (robots.txt)");
    }
  } catch (error) {
    if (error instanceof ExtractionError && error.message.includes("robots.txt")) throw error;
    // Sin robots.txt legible: se continúa.
  }

  const res = await fetchPublic(url.toString(), "text/html", opts);
  if (!res.ok) throw new ExtractionError(`La página respondió con error ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    throw new ExtractionError("La dirección no es una página web (HTML)");
  }

  const html = await readLimited(res);
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = (article?.textContent ?? document.body?.textContent ?? "").trim();
  if (text.length < 50) throw new ExtractionError("No se encontró texto legible en la página");
  return { text, title: article?.title?.trim() || document.title?.trim() || null };
}
