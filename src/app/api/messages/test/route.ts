import { isAuthorizedAdmin } from "@/lib/auth/admin-key";
import { ConfigError } from "@/lib/env";
import { getSupabaseAdmin, isSupabaseConfigured } from "@/lib/supabase/admin";
import { normalizePhone, sendTemplate, WhatsAppApiError } from "@/lib/whatsapp/client";
import {
  recordatorioParams,
  TEMPLATES,
  type RecordatorioVars,
} from "@/lib/whatsapp/templates";

interface TestBody extends RecordatorioVars {
  to: string;
}

/**
 * POST /api/messages/test
 * Envía la plantilla de recordatorio (event_details_reminder_2) a un número para probar la integración.
 * Requiere: Authorization: Bearer <ADMIN_API_KEY>
 */
export async function POST(request: Request) {
  if (!isAuthorizedAdmin(request)) {
    return Response.json({ error: "No autorizado" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as Partial<TestBody> | null;
  const missing = (["to", "nombre", "fecha", "hora", "negocio"] as const).filter(
    (key) => typeof body?.[key] !== "string" || body[key].trim() === "",
  );
  if (!body || missing.length > 0) {
    return Response.json({ error: `Faltan campos: ${missing.join(", ")}` }, { status: 400 });
  }

  const vars: RecordatorioVars = {
    nombre: body.nombre!.trim(),
    fecha: body.fecha!.trim(),
    hora: body.hora!.trim(),
    negocio: body.negocio!.trim(),
  };

  try {
    const result = await sendTemplate({
      to: body.to!,
      template: TEMPLATES.recordatorio,
      bodyParams: recordatorioParams(vars),
    });

    if (isSupabaseConfigured()) {
      const { error } = await getSupabaseAdmin().from("messages").insert({
        to_phone: normalizePhone(body.to!),
        kind: "test",
        template_name: TEMPLATES.recordatorio,
        variables: vars,
        wa_message_id: result.messageId,
        status: "accepted",
      });
      if (error) console.error("[messages/test] No se pudo guardar el mensaje:", error);
    }

    return Response.json({ ok: true, messageId: result.messageId, waId: result.waId });
  } catch (error) {
    if (error instanceof WhatsAppApiError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code, details: error.details },
        { status: 502 },
      );
    }
    if (error instanceof ConfigError) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }
    console.error("[messages/test] Error inesperado:", error);
    return Response.json({ ok: false, error: "Error inesperado" }, { status: 500 });
  }
}
