import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type Channel = "whatsapp" | "web";

export interface Contact {
  id: string;
  businessId: string;
  channel: Channel;
  externalId: string;
  displayName: string | null;
  customerId: string | null;
  blocked: boolean;
}

interface Row {
  id: string;
  business_id: string;
  channel: Channel;
  external_id: string;
  display_name: string | null;
  customer_id: string | null;
  blocked: boolean;
}
const COLUMNS = "id, business_id, channel, external_id, display_name, customer_id, blocked";
const toContact = (r: Row): Contact => ({ id: r.id, businessId: r.business_id, channel: r.channel, externalId: r.external_id, displayName: r.display_name, customerId: r.customer_id, blocked: r.blocked });

/**
 * Contacto por (negocio, canal, id externo = teléfono). Si el teléfono corresponde a un `customers` del negocio,
 * se enlaza `customer_id` (así el chatbot conoce su próximo turno). Seguro ante llamadas simultáneas.
 */
export async function upsertContact(businessId: string, channel: Channel, externalId: string, profileName?: string | null): Promise<Contact> {
  const db = getSupabaseAdmin();
  const { data: existing, error } = await db
    .from("chat_contacts")
    .select(COLUMNS)
    .eq("business_id", businessId)
    .eq("channel", channel)
    .eq("external_id", externalId)
    .maybeSingle<Row>();
  if (error) throw error;

  const update: Record<string, unknown> = {};
  let customerId = existing?.customer_id ?? null;
  if (!customerId && channel === "whatsapp") {
    const { data: customer } = await db.from("customers").select("id").eq("business_id", businessId).eq("phone", externalId).maybeSingle();
    customerId = customer?.id ?? null;
  }

  if (existing) {
    if (customerId !== existing.customer_id) update.customer_id = customerId;
    if (profileName && profileName !== existing.display_name) update.display_name = profileName.slice(0, 200);
    if (Object.keys(update).length === 0) return toContact(existing);
    const { data, error: updateError } = await db.from("chat_contacts").update(update).eq("id", existing.id).select(COLUMNS).single<Row>();
    if (updateError) throw updateError;
    return toContact(data);
  }

  const { data, error: insertError } = await db
    .from("chat_contacts")
    .insert({ business_id: businessId, channel, external_id: externalId, display_name: profileName?.slice(0, 200) ?? null, customer_id: customerId })
    .select(COLUMNS)
    .single<Row>();
  if (insertError?.code === "23505") return upsertContact(businessId, channel, externalId, profileName); // otro proceso lo creó a la vez
  if (insertError) throw insertError;
  return toContact(data);
}
