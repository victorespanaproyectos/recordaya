import { ConfigError } from "@/lib/env";

export const badRequest = (error: string) => Response.json({ error }, { status: 400 });
export const unauthorized = () => Response.json({ error: "No autorizado" }, { status: 401 });
export const notFound = (error = "No encontrado") => Response.json({ error }, { status: 404 });

/** Respuesta 500 uniforme; los ConfigError muestran qué variable falta. */
export function serverError(scope: string, error: unknown): Response {
  if (error instanceof ConfigError) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  console.error(`[${scope}] Error inesperado:`, error);
  return Response.json({ error: "Error inesperado" }, { status: 500 });
}

export async function readJson<T>(request: Request): Promise<Partial<T> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Partial<T>) : null;
}

export const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";
