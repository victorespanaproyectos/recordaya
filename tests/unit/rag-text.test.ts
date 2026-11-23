import { describe, expect, it } from "vitest";
import { chunkFaq, chunkText, estimateTokens, MAX_TOKENS, OVERLAP_CHARS } from "@/lib/chatbot/rag/chunk";
import { normalizePages, normalizeText } from "@/lib/chatbot/rag/normalize";

describe("normalizeText", () => {
  it("NFC, controles fuera, espacios colapsados y saltos unificados", () => {
    expect(normalizeText("Café\u0000  con\t\tleche\r\n\r\n\r\n\r\nfin​ ")).toBe("Café con leche\n\nfin");
  });
  it("une palabras cortadas por guion de fin de línea, pero no guiones reales", () => {
    expect(normalizeText("atención al clien-\nte y blanco-\nNegro y 10-\n20")).toBe("atención al cliente y blanco-\nNegro y 10-\n20");
  });
  it("títulos: Markdown y líneas cortas en mayúsculas pasan a '## '", () => {
    const out = normalizeText("# Horarios\nLunes a viernes\n\nFORMAS DE PAGO\nEfectivo y tarjeta.\n\n### Contacto ###\nLlámanos");
    expect(out).toBe("## Horarios\nLunes a viernes\n\n## Formas de pago\nEfectivo y tarjeta.\n\n## Contacto\nLlámanos");
  });
  it("no toma como título una línea en mayúsculas con punto final, muy larga o sin letras", () => {
    const long = "A".repeat(61);
    expect(normalizeText(`HOLA.\n${long}\n12345\nOK`)).toBe(`HOLA.\n${long}\n12345\nOK`);
  });
  it("texto vacío o solo espacios → vacío", () => {
    expect(normalizeText(" \n\t ")).toBe("");
  });
});

describe("normalizePages", () => {
  it("quita encabezados y pies repetidos (con numeración distinta) en ≥ 50 % de las páginas", () => {
    const pages = ["Mi Empresa S.A.\nContenido uno\nPágina 1", "Mi Empresa S.A.\nContenido dos\nPágina 2", "Mi Empresa S.A.\nContenido tres\nPágina 3"];
    expect(normalizePages(pages)).toBe("Contenido uno\n\nContenido dos\n\nContenido tres");
  });
  it("una línea repetida en menos de la mitad se conserva", () => {
    const pages = ["Hola\nA", "Hola\nB", "C", "D", "E"];
    expect(normalizePages(pages)).toContain("Hola");
  });
  it("con menos de 3 páginas no quita nada", () => {
    expect(normalizePages(["Igual\nA", "Igual\nB"])).toBe("Igual\nA\n\nIgual\nB");
  });
});

// Generador pseudoaleatorio con semilla: pruebas de propiedad reproducibles.
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const WORDS = ["atención", "turno", "precio", "servicio", "cliente", "horario", "corte", "barba", "reserva", "pago", "tarjeta", "efectivo"];
function randomDoc(r: () => number): string {
  const parts: string[] = [];
  const sections = 1 + Math.floor(r() * 4);
  for (let s = 0; s < sections; s++) {
    if (r() < 0.8) parts.push(`## Sección ${s}`);
    const paragraphs = 1 + Math.floor(r() * 6);
    for (let p = 0; p < paragraphs; p++) {
      const sentences = 1 + Math.floor(r() * 12);
      const text = Array.from({ length: sentences }, () => {
        const n = 3 + Math.floor(r() * 30);
        const w = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ");
        return `${w}${r() < 0.5 ? "." : ""}`;
      }).join(" ");
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

describe("chunkText", () => {
  it("texto corto: un fragmento con el prefijo de contexto", () => {
    const [c, ...rest] = chunkText("## Horarios\nDe 9 a 18", "Info del local");
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ index: 0, section: "Horarios", content: "[Info del local] › Horarios\n## Horarios\nDe 9 a 18" });
  });

  it("propiedad: concatenar los textos propios reconstruye el original (100 documentos aleatorios)", () => {
    const r = rng(42);
    for (let i = 0; i < 100; i++) {
      const doc = normalizeText(randomDoc(r));
      const chunks = chunkText(doc, "Fuente");
      expect(chunks.map((c) => c.text).join(""), `doc ${i}`).toBe(doc);
    }
  });

  it("propiedad: ningún fragmento supera 800 tokens estimados y los índices son consecutivos", () => {
    const r = rng(7);
    for (let i = 0; i < 100; i++) {
      const chunks = chunkText(normalizeText(randomDoc(r)), "T".repeat(200));
      chunks.forEach((c, n) => {
        expect(c.index).toBe(n);
        expect(c.tokenEstimate).toBe(estimateTokens(c.content));
        expect(c.tokenEstimate, `doc ${i} chunk ${n}`).toBeLessThanOrEqual(MAX_TOKENS);
      });
    }
  });

  it("un texto largo sin saltos de línea ni puntos igualmente se divide dentro del límite", () => {
    const text = "palabra ".repeat(2000).trim();
    const chunks = chunkText(text, "Largo");
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(Math.max(...chunks.map((c) => c.tokenEstimate))).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it("una 'palabra' gigante (sin espacios) se corta de forma dura sin perder caracteres", () => {
    const text = "x".repeat(9000);
    const chunks = chunkText(text, "Gigante");
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(Math.max(...chunks.map((c) => c.tokenEstimate))).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it("solapamiento ≈ 15 %: los fragmentos de una misma sección repiten hasta 300 caracteres del anterior", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `Párrafo ${i} con bastante texto de relleno para ocupar espacio. `.repeat(3)).join("\n\n");
    const chunks = chunkText(normalizeText(doc), "Doc");
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(1)) {
      const body = c.content.split("\n").slice(1).join("\n"); // sin prefijo
      const overlap = body.slice(0, body.length - c.text.length).trim();
      expect(overlap.length).toBeGreaterThan(0);
      expect(overlap.length).toBeLessThanOrEqual(OVERLAP_CHARS);
      expect(chunks[c.index - 1].text.trimEnd().endsWith(overlap.trimEnd())).toBe(true);
    }
    expect(chunks[0].content.length - chunks[0].text.length).toBeLessThan(30); // el primero no lleva solapamiento
  });

  it("no hay solapamiento entre secciones distintas", () => {
    const [a, b] = chunkText("## Uno\nTexto uno.\n\n## Dos\nTexto dos.", "Doc");
    expect(a.section).toBe("Uno");
    expect(b.section).toBe("Dos");
    expect(b.content).toBe("[Doc] › Dos\n## Dos\nTexto dos.");
  });

  it("el título largo de la fuente y de la sección se recortan en el prefijo", () => {
    const [c] = chunkText(`## ${"S".repeat(300)}\nx`, "T".repeat(500));
    expect(c.content.split("\n")[0].length).toBeLessThan(230);
  });

  it("texto vacío → sin fragmentos", () => {
    expect(chunkText("", "Doc")).toEqual([]);
  });
});

describe("chunkFaq", () => {
  it("una FAQ normal es un solo fragmento", () => {
    const chunks = chunkFaq("¿Horario?", "De 9 a 18", "Horarios");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, text: "Pregunta: ¿Horario?\nRespuesta: De 9 a 18", content: "[Horarios]\nPregunta: ¿Horario?\nRespuesta: De 9 a 18" });
  });
  it("una FAQ que no cabe en 800 tokens se divide en vez de superar el límite", () => {
    const chunks = chunkFaq("¿Cómo funciona?", "Paso uno. ".repeat(450), "Larga");
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.tokenEstimate))).toBeLessThanOrEqual(MAX_TOKENS);
  });
});
