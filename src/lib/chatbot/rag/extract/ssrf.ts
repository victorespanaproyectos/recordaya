import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ExtractionError } from "./errors";

/** Protección SSRF: una URL de la base de conocimiento nunca puede apuntar a la red interna. */

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local y metadatos de nube (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado y broadcast
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = ipv4ToInt(base);
    return n >= start && n < start + size;
  });
}

/** Expande una IPv6 a sus 8 grupos de 16 bits (maneja `::` y la forma con IPv4 al final). */
function expandV6(ip: string): number[] | null {
  let addr = ip.split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    addr = addr.replace(v4[1], `${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`);
  }
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0");
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true; // lo que no se puede interpretar, se rechaza
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  // IPv4 mapeada (::ffff:a.b.c.d) o compatible: se evalúa la IPv4 incrustada.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return isPrivateV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64: puede traducir a IPv4 internas
  if (g[0] === 0x2002) return true; // 6to4
  return false;
}

/** ¿Es una IP que no debe alcanzarse desde el servidor? */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true;
}

export type Resolver = (hostname: string) => Promise<{ address: string }[]>;
const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true });

/**
 * Valida la URL y que TODAS las IP a las que resuelve su host sean públicas.
 * Solo https, puerto 443 (o sin puerto), sin credenciales. Devuelve la URL ya parseada.
 * Limitación conocida: entre esta comprobación y la conexión el DNS podría cambiar; se mitiga
 * volviendo a validar en cada redirección y con el tope de tamaño y de tiempo.
 */
export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ExtractionError("La dirección no es válida");
  }
  if (url.protocol !== "https:") throw new ExtractionError("Solo se admiten direcciones https://");
  if (url.username || url.password) throw new ExtractionError("La dirección no puede incluir usuario ni contraseña");
  if (url.port && url.port !== "443") throw new ExtractionError("Solo se admite el puerto 443");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new ExtractionError("La dirección apunta a una red privada y no se puede leer");
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ExtractionError("No se pudo encontrar el sitio. Revisa la dirección");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new ExtractionError("La dirección apunta a una red privada y no se puede leer");
  }
  return url;
}
