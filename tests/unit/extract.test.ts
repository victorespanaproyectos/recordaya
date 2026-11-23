import { describe, expect, it, vi } from "vitest";
import { ExtractionError, extractContent, DOCX_MIME, PDF_MIME, TXT_MIME } from "@/lib/chatbot/rag/extract";
import { robotsDisallows } from "@/lib/chatbot/rag/extract/url";
import { assertPublicUrl, isPrivateIp } from "@/lib/chatbot/rag/extract/ssrf";
import { bytes, makeDocx, makePdf } from "../helpers/fixtures";

const failsWith = async (p: Promise<unknown>, fragment: string) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ExtractionError);
  expect((e as Error).message).toContain(fragment);
};
const file = (data: Uint8Array, mimeType: string) => extractContent({ kind: "file", bytes: data, mimeType });

describe("TXT", () => {
  it("UTF-8", async () => {
    expect((await file(bytes("Horario:\n  de 9 a 18  \n\n\n\nCafé"), TXT_MIME)).text).toBe("Horario:\nde 9 a 18\n\nCafé");
  });
  it("latin1 cuando no es UTF-8 válido", async () => {
    const latin1 = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x69, 0xf1, 0x6f]); // "Café niño"
    expect((await file(latin1, TXT_MIME)).text).toBe("Café niño");
  });
  it("rechaza binarios, vacíos y demasiado grandes", async () => {
    await failsWith(file(Uint8Array.from([65, 0, 66]), TXT_MIME), "binario");
    await failsWith(file(new Uint8Array(0), TXT_MIME), "vacío");
    await failsWith(file(new Uint8Array(10 * 1024 * 1024 + 1).fill(65), TXT_MIME), "10 MB");
    await failsWith(file(bytes("   \n  "), TXT_MIME), "No se encontró texto");
  });
});

describe("PDF", () => {
  it("PDF con texto", async () => {
    const text = "Nuestro horario de atencion es de lunes a viernes de nueve a dieciocho horas.";
    const r = await file(makePdf([text]), PDF_MIME);
    expect(r.pages).toBe(1);
    expect(r.text).toContain("horario de atencion");
  });
  it("varias páginas", async () => {
    const names = ["uno", "dos", "tres"];
    const page = (n: number) => `Contenido de la pagina ${n} sobre el tema ${names[n - 1]} con suficiente texto para superar el minimo.`;
    // Las líneas de cada página son distintas (solo cambia el número): sin zona de encabezado/pie compartida no se borran.
    const r = await file(makePdf([page(1), page(2), page(3)]), PDF_MIME);
    expect(r.pages).toBe(3);
    expect(r.text).toContain("pagina 1");
    expect(r.text).toContain("pagina 3");
  });
  it("PDF escaneado (sin texto) falla con un mensaje claro", async () => {
    await failsWith(file(makePdf(["", ""]), PDF_MIME), "escaneado");
  });
  it("rechaza lo que no es PDF, lo dañado y lo demasiado grande", async () => {
    await failsWith(file(bytes("hola"), PDF_MIME), "no es un PDF");
    await failsWith(file(bytes("%PDF-1.4 basura sin estructura"), PDF_MIME), "dañado");
    await failsWith(file(new Uint8Array(10 * 1024 * 1024 + 1), PDF_MIME), "10 MB");
  });
});

describe("DOCX", () => {
  it("extrae los párrafos", async () => {
    const r = await file(await makeDocx(["Lista de precios", "Corte: $400", "Barba: $250"]), DOCX_MIME);
    expect(r.text).toContain("Corte: $400");
    expect(r.text).toContain("Barba: $250");
  });
  it("rechaza lo que no es un ZIP, un ZIP sin document.xml y un documento sin texto", async () => {
    await failsWith(file(bytes("no soy un zip"), DOCX_MIME), "no es un documento de Word");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("otra-cosa.txt", "x");
    await failsWith(file(await zip.generateAsync({ type: "uint8array" }), DOCX_MIME), "no es un documento de Word");
    await failsWith(file(await makeDocx([""]), DOCX_MIME), "no tiene texto");
  });
  it("rechaza un ZIP con tamaño descomprimido excesivo (anti zip-bomb)", async () => {
    const bomb = await makeDocx(["hola"], { "relleno.bin": new Uint8Array(51 * 1024 * 1024) });
    expect(bomb.byteLength).toBeLessThan(10 * 1024 * 1024); // comprime muy bien
    await failsWith(file(bomb, DOCX_MIME), "demasiado grande");
  });
});

describe("tipo no admitido", () => {
  it("rechaza otros tipos", async () => {
    await failsWith(file(bytes("x"), "image/png"), "no admitido");
  });
});

describe("SSRF", () => {
  it.each([
    "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "127.1.2.3",
    "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::1", "2002::1", "no-es-ip",
  ])("%s es privada", (ip) => expect(isPrivateIp(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "193.0.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"])(
    "%s es pública",
    (ip) => expect(isPrivateIp(ip)).toBe(false),
  );

  const resolverTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));
  it("rechaza esquemas, puertos, credenciales y direcciones inválidas", async () => {
    await failsWith(assertPublicUrl("http://example.com"), "https");
    await failsWith(assertPublicUrl("ftp://example.com"), "https");
    await failsWith(assertPublicUrl("https://example.com:8443/x", resolverTo("8.8.8.8")), "puerto 443");
    await failsWith(assertPublicUrl("https://u:p@example.com", resolverTo("8.8.8.8")), "usuario");
    await failsWith(assertPublicUrl("no es url"), "no es válida");
  });
  it("rechaza IP literales privadas", async () => {
    await failsWith(assertPublicUrl("https://127.0.0.1/"), "red privada");
    await failsWith(assertPublicUrl("https://[::1]/"), "red privada");
    await failsWith(assertPublicUrl("https://169.254.169.254/latest/meta-data"), "red privada");
  });
  it("rechaza un nombre que resuelve a una IP privada, aunque otra sea pública (DNS rebinding)", async () => {
    await failsWith(assertPublicUrl("https://interno.example.com", resolverTo("10.0.0.5")), "red privada");
    await failsWith(assertPublicUrl("https://mixto.example.com", resolverTo("8.8.8.8", "127.0.0.1")), "red privada");
  });
  it("rechaza un nombre que no resuelve y acepta uno público", async () => {
    await failsWith(assertPublicUrl("https://nada.example.com", async () => { throw new Error("ENOTFOUND"); }), "encontrar el sitio");
    expect((await assertPublicUrl("https://example.com/a?b=1", resolverTo("93.184.216.34"))).hostname).toBe("example.com");
  });
});

describe("URL", () => {
  const page = (body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
  const resolver = async () => [{ address: "93.184.216.34" }];
  const run = (fetcher: typeof fetch, url = "https://example.com/info") => extractContent({ kind: "url", url, options: { fetcher, resolver } });

  const ARTICLE = `<html><head><title>Mi barbería</title></head><body><nav>Inicio | Contacto</nav><article><h1>Servicios</h1>
    <p>Ofrecemos corte de pelo, barba y coloración con turnos todos los días de la semana. Atendemos de lunes a sábado.</p>
    <p>Los precios incluyen lavado y peinado. Aceptamos efectivo y tarjetas de débito y crédito sin recargo.</p></article></body></html>`;

  it("extrae el texto principal; usa User-Agent identificable y no sigue ocultando el robots.txt", async () => {
    const fetcher = vi.fn(async (u: URL | string) => (String(u).endsWith("/robots.txt") ? new Response("", { status: 404 }) : page(ARTICLE))) as unknown as typeof fetch;
    const r = await run(fetcher);
    expect(r.text).toContain("corte de pelo, barba y coloración");
    expect(r.text).not.toContain("Inicio | Contacto");
    const init = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(init.headers["User-Agent"]).toBe("RecordaYaBot/1.0");
    expect(init.redirect).toBe("manual");
  });

  it("respeta robots.txt", async () => {
    const fetcher = (async (u: URL | string) =>
      String(u).endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /info", { status: 200 }) : page(ARTICLE)) as typeof fetch;
    await failsWith(run(fetcher), "robots.txt");
  });

  it("sigue hasta 3 redirecciones y valida cada destino contra SSRF", async () => {
    let n = 0;
    const redirecting = (async (u: URL | string) => {
      if (String(u).endsWith("/robots.txt")) return new Response("", { status: 404 });
      return n++ < 3 ? new Response(null, { status: 302, headers: { location: `/paso${n}` } }) : page(ARTICLE);
    }) as typeof fetch;
    expect((await run(redirecting)).text).toContain("corte de pelo");

    const tooMany = (async (u: URL | string) =>
      String(u).endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(null, { status: 302, headers: { location: "/otra" } })) as typeof fetch;
    await failsWith(run(tooMany), "demasiadas veces");

    const toInternal = (async (u: URL | string) =>
      String(u).endsWith("/robots.txt") ? new Response("", { status: 404 }) : new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } })) as typeof fetch;
    await failsWith(run(toInternal), "red privada");
  });

  it("rechaza contenido que no es HTML, errores HTTP, páginas pesadas y páginas sin texto", async () => {
    const with404 = (res: () => Response) => (async (u: URL | string) => (String(u).endsWith("/robots.txt") ? new Response("", { status: 404 }) : res())) as typeof fetch;
    await failsWith(run(with404(() => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))), "no es una página web");
    await failsWith(run(with404(() => new Response("x", { status: 500 }))), "error 500");
    await failsWith(run(with404(() => page("x", { "content-length": String(3 * 1024 * 1024) }))), "2 MB");
    await failsWith(run(with404(() => page("a".repeat(2 * 1024 * 1024 + 10)))), "2 MB");
    await failsWith(run(with404(() => page("<html><body><p>hola</p></body></html>"))), "texto legible");
  });

  it("URL a 127.0.0.1 o con http se rechaza sin hacer ninguna petición", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await failsWith(run(fetcher, "https://127.0.0.1/"), "red privada");
    await failsWith(run(fetcher, "http://example.com/"), "https");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("robotsDisallows", () => {
  it.each([
    ["User-agent: *\nDisallow: /", "/info", true],
    ["User-agent: *\nDisallow: /privado", "/info", false],
    ["User-agent: *\nDisallow: /privado", "/privado/x", true],
    ["User-agent: *\nDisallow: /\nAllow: /info", "/info/a", false],
    ["User-agent: googlebot\nDisallow: /", "/info", false],
    ["User-agent: RecordaYaBot\nDisallow: /info\n\nUser-agent: *\nAllow: /", "/info", true],
    ["User-agent: *\nDisallow:", "/info", false],
    ["# comentario\nUser-agent: *\nDisallow: /info # nota", "/info", true],
  ])("%j en %s → %s", (robots, path, expected) => expect(robotsDisallows(robots, path)).toBe(expected));
});
