import { getWhatsAppConfig, type TemplateParamFormat } from "@/lib/env";

const GRAPH_URL = "https://graph.facebook.com";

export interface TemplateParam {
  /** Nombre de la variable (se usa si la plantilla tiene variables con nombre). */
  name: string;
  value: string;
}

export interface SendTemplateInput {
  /** Teléfono destino en formato internacional, con o sin "+" (ej: 59899123456). */
  to: string;
  /** Nombre exacto de la plantilla aprobada en WhatsApp Manager. */
  template: string;
  /** Variables del cuerpo, EN EL ORDEN de la plantilla. */
  bodyParams?: TemplateParam[];
  language?: string;
  paramFormat?: TemplateParamFormat;
}

export interface SendTemplateResult {
  /** ID del mensaje (wamid...). Llega luego en los webhooks de estado. */
  messageId: string;
  waId?: string;
}

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

/** Deja solo dígitos: "+598 99 123 456" → "59899123456". */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export async function sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
  const config = getWhatsAppConfig();
  const format = input.paramFormat ?? config.paramFormat;
  const params = input.bodyParams ?? [];

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizePhone(input.to),
    type: "template",
    template: {
      name: input.template,
      language: { code: input.language ?? config.templateLanguage },
      ...(params.length > 0 && {
        components: [
          {
            type: "body",
            parameters: params.map((p) =>
              format === "named"
                ? { type: "text", parameter_name: p.name, text: p.value }
                : { type: "text", text: p.value },
            ),
          },
        ],
      }),
    },
  };

  const res = await fetch(
    `${GRAPH_URL}/${config.apiVersion}/${config.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  const data = (await res.json().catch(() => null)) as GraphSendResponse | GraphErrorResponse | null;

  if (!res.ok || !data || "error" in data) {
    const err = data && "error" in data ? data.error : undefined;
    throw new WhatsAppApiError(
      err?.error_user_msg ?? err?.message ?? `Error HTTP ${res.status} de la Cloud API`,
      res.status,
      err?.code,
      err,
    );
  }

  return { messageId: data.messages[0].id, waId: data.contacts?.[0]?.wa_id };
}

interface GraphSendResponse {
  messaging_product: "whatsapp";
  contacts?: { input: string; wa_id: string }[];
  messages: { id: string; message_status?: string }[];
}

interface GraphErrorResponse {
  error: {
    message: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    error_data?: unknown;
    fbtrace_id?: string;
  };
}
