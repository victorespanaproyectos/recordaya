import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface ResolvedBusiness {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
}

/**
 * Negocio dueño del número de WhatsApp que recibió el mensaje (`businesses.wa_phone_number_id`).
 * Un `phone_number_id` desconocido o ausente devuelve `null`: el router lo trata como ruta legacy,
 * nunca se "adivina" un negocio.
 */
export async function resolveBusiness(phoneNumberId: string | null | undefined): Promise<ResolvedBusiness | null> {
  if (!phoneNumberId) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("businesses")
    .select("id, name, address, timezone")
    .eq("wa_phone_number_id", phoneNumberId)
    .maybeSingle();
  if (error) throw error;
  return data;
}
