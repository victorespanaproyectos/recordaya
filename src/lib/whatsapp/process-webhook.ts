import { handleCustomerReply } from "@/lib/appointments/replies";
import { getSupabaseAdmin, isSupabaseConfigured } from "@/lib/supabase/admin";
import {
  incomingText,
  type WaIncomingMessage,
  type WaStatusUpdate,
  type WaWebhookPayload,
} from "./webhook";

/** Orden de los estados: nunca "bajamos" de read a delivered si llegan desordenados. */
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
};

const STATUS_TIMESTAMP_COLUMN: Record<WaStatusUpdate["status"], string> = {
  sent: "sent_at",
  delivered: "delivered_at",
  read: "read_at",
  failed: "failed_at",
};

export async function processWebhook(payload: WaWebhookPayload): Promise<void> {
  if (!isSupabaseConfigured()) {
    console.info("[webhook] Supabase sin configurar; evento recibido:", JSON.stringify(payload));
    return;
  }

  const db = getSupabaseAdmin();
  await db.from("webhook_events").insert({ payload });

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const { statuses = [], messages = [] } = change.value;

      for (const status of statuses) await applyStatus(status);
      for (const message of messages) await saveIncoming(message);
    }
  }
}

async function applyStatus(update: WaStatusUpdate): Promise<void> {
  const db = getSupabaseAdmin();

  const { data: current, error } = await db
    .from("messages")
    .select("id, status")
    .eq("wa_message_id", update.id)
    .maybeSingle();

  if (error) throw error;
  if (!current) return; // mensaje enviado fuera de la app (ej. desde el panel de Meta)

  const isNewer = STATUS_RANK[update.status] > (STATUS_RANK[current.status] ?? 0);
  if (!isNewer) return;

  const at = new Date(Number(update.timestamp) * 1000).toISOString();
  const { error: updateError } = await db
    .from("messages")
    .update({
      status: update.status,
      [STATUS_TIMESTAMP_COLUMN[update.status]]: at,
      ...(update.errors && { error: update.errors }),
    })
    .eq("id", current.id);

  if (updateError) throw updateError;
}

async function saveIncoming(message: WaIncomingMessage): Promise<void> {
  const db = getSupabaseAdmin();
  const { data, error } = await db.from("inbound_messages").upsert(
    {
      wa_message_id: message.id,
      from_phone: message.from,
      type: message.type,
      body: incomingText(message),
      reply_to_wa_message_id: message.context?.id ?? null,
      payload: message,
      received_at: new Date(Number(message.timestamp) * 1000).toISOString(),
    },
    { onConflict: "wa_message_id", ignoreDuplicates: true },
  ).select("id");
  if (error) throw error;

  // Vacío = Meta reintentó un mensaje que ya procesamos.
  const inserted = data?.[0];
  if (!inserted) return;

  await handleCustomerReply({
    inboundId: inserted.id,
    fromPhone: message.from,
    text: incomingText(message),
    replyTo: message.context?.id ?? null,
  });
}
