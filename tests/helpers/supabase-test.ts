import { randomUUID } from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

/**
 * Base de pruebas. Las pruebas de integración escriben datos reales, así que:
 *  - solo corren contra Supabase local (127.0.0.1 / localhost), o
 *  - contra un proyecto remoto si .env.test declara TEST_DB_CONFIRM = host del SUPABASE_URL
 *    (confirmación explícita de que NO es producción).
 * Cada ejecución crea su propio negocio y lo borra al terminar (cascade).
 */
export function dbConfigured(): boolean {
  const url = process.env.SUPABASE_URL;
  if (!url || !process.env.SUPABASE_SECRET_KEY) return false;
  const host = new URL(url).hostname;
  if (host === "127.0.0.1" || host === "localhost") return true;
  return process.env.TEST_DB_CONFIRM === host;
}

export const RUN_ID = randomUUID().slice(0, 8);
/** Marca en `entry[].id` de los webhooks de prueba, para poder borrar su rastro. */
export const WEBHOOK_MARKER = `TEST-${RUN_ID}`;
/** Prefijo de los wamid entrantes de prueba. */
export const INBOUND_PREFIX = `wamid.TEST.IN.${RUN_ID}.`;

let phoneCounter = 0;
const usedPhones: string[] = [];

/** Teléfono ficticio único por prueba (nunca coincide con otra prueba ni con datos reales). */
export function testPhone(): string {
  const n = String(Math.floor(Math.random() * 1_000_000) + phoneCounter++).padStart(7, "0").slice(-7);
  const phone = `59890${n}`;
  usedPhones.push(phone);
  return phone;
}

export interface TestBusiness {
  id: string;
  name: string;
  timezone: string;
}

export async function createTestBusiness(): Promise<TestBusiness> {
  const name = `Negocio de prueba ${RUN_ID}`;
  const timezone = "America/Montevideo";
  const { data, error } = await getSupabaseAdmin()
    .from("businesses")
    .insert({ name, timezone, address: "Calle Falsa 123" })
    .select("id")
    .single();
  if (error) throw error;
  return { id: data.id, name, timezone };
}

export async function createCustomer(businessId: string, phone: string, name = "Cliente Prueba") {
  const { data, error } = await getSupabaseAdmin()
    .from("customers")
    .insert({ business_id: businessId, phone, name })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function insertAppointment(opts: {
  businessId: string;
  phone: string;
  startsAt: Date;
  status?: string;
  name?: string;
  service?: string | null;
}) {
  const db = getSupabaseAdmin();
  const { data: existing } = await db
    .from("customers")
    .select("id")
    .eq("business_id", opts.businessId)
    .eq("phone", opts.phone)
    .maybeSingle();
  const customerId = existing?.id ?? (await createCustomer(opts.businessId, opts.phone, opts.name));
  const { data, error } = await db
    .from("appointments")
    .insert({
      business_id: opts.businessId,
      customer_id: customerId,
      starts_at: opts.startsAt.toISOString(),
      status: opts.status ?? "scheduled",
      service: opts.service ?? "Corte",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/** Mensaje saliente ya enviado (para poder "citarlo" desde una respuesta del cliente). */
export async function insertSentMessage(opts: {
  businessId: string;
  appointmentId: string;
  phone: string;
  kind?: string;
  wamid: string;
}) {
  const { error } = await getSupabaseAdmin().from("messages").insert({
    business_id: opts.businessId,
    appointment_id: opts.appointmentId,
    to_phone: opts.phone,
    kind: opts.kind ?? "reminder_24h",
    template_name: "event_details_reminder_2",
    status: "accepted",
    sent_at: new Date().toISOString(),
    wa_message_id: opts.wamid,
  });
  if (error) throw error;
}

export const db = () => getSupabaseAdmin();

/** Borra el negocio de la ejecución y todo rastro de los teléfonos y webhooks de prueba. */
export async function cleanup(businessId: string | undefined) {
  const client = getSupabaseAdmin();
  if (businessId) await client.from("businesses").delete().eq("id", businessId); // cascade
  if (usedPhones.length > 0) {
    await client.from("messages").delete().in("to_phone", usedPhones);
    await client.from("inbound_messages").delete().in("from_phone", usedPhones);
  }
  await client.from("inbound_messages").delete().like("wa_message_id", `${INBOUND_PREFIX}%`);
  await client.from("webhook_events").delete().contains("payload", { entry: [{ id: WEBHOOK_MARKER }] });
}
