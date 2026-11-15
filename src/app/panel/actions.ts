"use server";

import { refresh } from "next/cache";
import {
  createAppointment,
  ServiceError,
  STATUS_UPDATES,
  updateAppointment,
  type StatusUpdate,
} from "@/lib/appointments/service";
import { zonedToUtc } from "@/lib/dates";
import { requirePanelSession } from "@/lib/panel/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  /** Id del turno creado/modificado, para enlazar al detalle. */
  id?: string;
  /** Aviso no bloqueante (ej. el turno se creó pero WhatsApp falló). */
  warning?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v.trim() : "");

function toResult(error: unknown, scope: string): ActionResult {
  if (error instanceof ServiceError) return { ok: false, error: error.message };
  console.error(`[panel/${scope}]`, error);
  return { ok: false, error: "Algo salió mal. Intenta de nuevo en unos segundos." };
}

async function businessTimezone(businessId: string): Promise<string | null> {
  const { data } = await getSupabaseAdmin()
    .from("businesses")
    .select("timezone")
    .eq("id", businessId)
    .maybeSingle();
  return data?.timezone ?? null;
}

export async function createAppointmentAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePanelSession();

  const businessId = str(formData.get("businessId"));
  if (!UUID_RE.test(businessId)) return { ok: false, error: "Elige un negocio" };

  const timeZone = await businessTimezone(businessId);
  if (!timeZone) return { ok: false, error: "El negocio no existe" };

  const startsAt = zonedToUtc(str(formData.get("date")), str(formData.get("time")), timeZone);
  if (!startsAt) return { ok: false, error: "Completa la fecha y la hora" };

  const phone = `${str(formData.get("countryCode"))}${str(formData.get("phone"))}`;

  try {
    const result = await createAppointment({
      businessId,
      customerName: str(formData.get("name")),
      customerPhone: phone,
      startsAt,
      service: str(formData.get("service")) || null,
      notes: str(formData.get("notes")) || null,
      notify: formData.get("notify") === "on",
    });
    refresh();
    return {
      ok: true,
      id: result.appointment.id,
      message: `Turno creado para ${result.appointment.customer.name}`,
      warning:
        result.confirmation && !result.confirmation.ok
          ? `No se pudo enviar la confirmación por WhatsApp: ${result.confirmation.error}`
          : undefined,
    };
  } catch (error) {
    return toResult(error, "create");
  }
}

const STATUS_MESSAGES: Record<StatusUpdate, string> = {
  confirmed: "Turno confirmado",
  cancelled: "Turno cancelado",
  completed: "Turno marcado como atendido",
  no_show: "Turno marcado como ausente",
};

export async function setStatusAction(
  id: string,
  status: StatusUpdate,
  notify = true,
): Promise<ActionResult> {
  await requirePanelSession();
  if (!UUID_RE.test(id)) return { ok: false, error: "Turno inválido" };
  if (!STATUS_UPDATES.includes(status)) return { ok: false, error: "Estado inválido" };

  try {
    const result = await updateAppointment(id, { status, notify });
    refresh();
    return {
      ok: true,
      id,
      message: STATUS_MESSAGES[status],
      warning:
        result.notification && !result.notification.ok
          ? `No se pudo avisar por WhatsApp: ${result.notification.error}`
          : undefined,
    };
  } catch (error) {
    return toResult(error, "status");
  }
}

export async function rescheduleAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  await requirePanelSession();

  const id = str(formData.get("id"));
  const timeZone = str(formData.get("timeZone"));
  if (!UUID_RE.test(id) || !timeZone) return { ok: false, error: "Turno inválido" };

  const startsAt = zonedToUtc(str(formData.get("date")), str(formData.get("time")), timeZone);
  if (!startsAt) return { ok: false, error: "Completa la fecha y la hora" };

  try {
    const result = await updateAppointment(id, {
      startsAt,
      notify: formData.get("notify") === "on",
    });
    refresh();
    return {
      ok: true,
      id,
      message: "Turno reprogramado",
      warning:
        result.notification && !result.notification.ok
          ? `No se pudo avisar por WhatsApp: ${result.notification.error}`
          : undefined,
    };
  } catch (error) {
    return toResult(error, "reschedule");
  }
}
