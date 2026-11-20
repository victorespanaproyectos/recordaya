/** Normalización de texto extraído (04 §15.3). Funciones puras. */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‍⁠﻿]/g;

/** ¿Es una línea de título? Markdown (#) o línea corta en mayúsculas sin punto final. */
function headingOf(line: string): string | null {
  const md = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if (md) return md[1].trim();
  const t = line.trim();
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (t.length <= 60 && letters.length >= 3 && t === t.toUpperCase() && t === t.toLocaleUpperCase("es") && !/[.:;,]$/.test(t)) {
    return t.charAt(0) + t.slice(1).toLocaleLowerCase("es");
  }
  return null;
}

/** NFC, sin caracteres de control, espacios colapsados, guiones de corte unidos y títulos como `## `. */
export function normalizeText(input: string): string {
  const text = input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2") // palabra cortada por fin de línea
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n");

  const lines = text.split("\n").map((line) => {
    const h = headingOf(line);
    return h ? `## ${h}` : line;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Clave para comparar encabezados/pies entre páginas: sin números (numeración de página). */
const pageLineKey = (line: string) => line.trim().replace(/\d+/g, "#").toLowerCase();

/**
 * Normaliza un documento paginado: quita las líneas repetidas en ≥ 50 % de las páginas
 * (encabezados y pies) y une las páginas. Con menos de 3 páginas no se puede distinguir un pie de contenido.
 */
export function normalizePages(pages: string[]): string {
  if (pages.length >= 3) {
    const ZONE = 3; // un encabezado o pie está entre las primeras o últimas líneas de la página
    const zoneLines = (page: string) => {
      const lines = page.split("\n").map((l, i) => ({ l, i })).filter((x) => x.l.trim());
      return new Set([...lines.slice(0, ZONE), ...lines.slice(-ZONE)].map((x) => x.i));
    };
    const counts = new Map<string, number>();
    for (const page of pages) {
      const lines = page.split("\n");
      const keys = new Set([...zoneLines(page)].map((i) => pageLineKey(lines[i])));
      for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = new Set([...counts].filter(([, n]) => n >= pages.length / 2).map(([k]) => k));
    pages = pages.map((page) => {
      const zone = zoneLines(page);
      return page
        .split("\n")
        .filter((line, i) => !(zone.has(i) && repeated.has(pageLineKey(line))))
        .join("\n");
    });
  }
  return normalizeText(pages.join("\n\n"));
}
