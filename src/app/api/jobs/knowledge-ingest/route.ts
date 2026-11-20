import { z } from "zod";
import { ingestDocument } from "@/lib/chatbot/rag/ingest";
import { log } from "@/lib/logger";
import { verifyQStashSignature } from "@/lib/scheduler/qstash";

/** Margen para extraer, embeber por tandas y re-encolarse; la ingesta corta su propio presupuesto a los 40 s. */
export const maxDuration = 60;

const Body = z.object({ documentId: z.uuid() });

/**
 * POST /api/jobs/knowledge-ingest
 * Lo llama QStash. Body: { documentId }. 200 con el resultado (ready | failed | continued | skipped);
 * 500 ante un fallo transitorio para que QStash reintente.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!(await verifyQStashSignature(request, raw))) {
    return Response.json({ error: "Firma inválida" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = Body.safeParse(JSON.parse(raw));
  } catch {
    return Response.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!parsed.success) return Response.json({ error: "Body inválido" }, { status: 400 });

  try {
    return Response.json(await ingestDocument(parsed.data.documentId));
  } catch (error) {
    log.error("jobs/knowledge-ingest", error, { documentId: parsed.data.documentId });
    return Response.json({ error: "Error temporal" }, { status: 500 });
  }
}
