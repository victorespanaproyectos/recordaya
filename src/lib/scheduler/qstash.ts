import { Client, Receiver } from "@upstash/qstash";
import { getAppUrl, requireEnv } from "@/lib/env";

/**
 * Envíos programados con Upstash QStash.
 * QStash guarda el mensaje y llama a nuestro endpoint en la fecha indicada (notBefore).
 */

let client: Client | null = null;

/**
 * QSTASH_DEV=true → servidor local de QStash (127.0.0.1:8080), sin cuenta ni túnel.
 * El SDK lo descarga y lo arranca solo, con credenciales de desarrollo fijas.
 */
export function isQStashDevMode(): boolean {
  return process.env.QSTASH_DEV === "true" || process.env.QSTASH_DEV === "1";
}

function getClient(): Client {
  if (!client) {
    client = isQStashDevMode()
      ? new Client({ devMode: true })
      : new Client({
          token: requireEnv("QSTASH_TOKEN"),
          ...(process.env.QSTASH_URL && { baseUrl: process.env.QSTASH_URL }),
        });
  }
  return client;
}

/** Ruta del job que envía un recordatorio. */
export const SEND_REMINDER_PATH = "/api/jobs/send-reminder";

/** Días máximos que QStash acepta de demora (depende del plan). Más allá, lo agenda el job "dispatch". */
export function maxDelayMs(): number {
  const days = Number(process.env.QSTASH_MAX_DELAY_DAYS || 7);
  return (Number.isFinite(days) && days > 0 ? days : 7) * 24 * 60 * 60 * 1000;
}

export interface SendReminderJob {
  messageId: string;
}

/**
 * Programa el envío del mensaje `messageId` para la fecha `at`.
 * Devuelve el id de QStash (se guarda en messages.schedule_id para poder cancelarlo).
 */
export async function scheduleReminder(messageId: string, at: Date): Promise<string> {
  const res = await getClient().publishJSON<SendReminderJob>({
    url: `${getAppUrl()}${SEND_REMINDER_PATH}`,
    body: { messageId },
    notBefore: Math.floor(at.getTime() / 1000),
    // Si dos llamadas programan el mismo mensaje, QStash lo descarta.
    deduplicationId: `reminder-${messageId}-${at.getTime()}`,
    retries: 3,
    label: "reminder",
  });
  if (!("messageId" in res)) throw new Error("QStash no devolvió messageId");
  return res.messageId;
}

export interface PublishJobOptions {
  /** Demora en segundos (QStash la trabaja en segundos enteros: se redondea hacia arriba). */
  delaySeconds?: number;
  /** QStash descarta publicaciones repetidas con el mismo id. */
  deduplicationId?: string;
  retries?: number;
}

/**
 * Encola un job genérico: QStash llamará a `path` (de esta app) con `body` firmado.
 * Devuelve el id de QStash.
 */
export async function publishJob<T extends Record<string, unknown> | unknown[]>(
  path: string,
  body: T,
  options: PublishJobOptions = {},
): Promise<string> {
  if (!path.startsWith("/api/jobs/")) throw new Error(`Ruta de job no permitida: ${path}`);
  const res = await getClient().publishJSON<T>({
    url: `${getAppUrl()}${path}`,
    body,
    ...(options.delaySeconds !== undefined && options.delaySeconds > 0 && { delay: Math.ceil(options.delaySeconds) }),
    ...(options.deduplicationId && { deduplicationId: options.deduplicationId }),
    retries: options.retries ?? 3,
    label: path.split("/").pop(),
  });
  if (!("messageId" in res)) throw new Error("QStash no devolvió messageId");
  return res.messageId;
}

/** Cancela un envío programado. Si ya se entregó o no existe, no hace nada. */
export async function cancelScheduled(scheduleId: string): Promise<void> {
  try {
    await getClient().messages.delete(scheduleId);
  } catch (error) {
    console.warn(`[qstash] No se pudo cancelar ${scheduleId}:`, error);
  }
}

/** Verifica la firma "Upstash-Signature" de una llamada entrante. */
export async function verifyQStashSignature(request: Request, rawBody: string): Promise<boolean> {
  const signature = request.headers.get("upstash-signature");
  if (!signature) return false;

  const receiver = isQStashDevMode()
    ? new Receiver({ devMode: true })
    : new Receiver({
        currentSigningKey: requireEnv("QSTASH_CURRENT_SIGNING_KEY"),
        nextSigningKey: requireEnv("QSTASH_NEXT_SIGNING_KEY"),
      });

  try {
    return await receiver.verify({
      signature,
      body: rawBody,
      clockTolerance: 5,
      upstashRegion: request.headers.get("upstash-region") ?? undefined,
    });
  } catch {
    return false;
  }
}
