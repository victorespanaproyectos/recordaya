/**
 * Lectura centralizada de variables de entorno del servidor.
 * Nunca importes este archivo desde un Client Component.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ConfigError(
      `Falta la variable de entorno ${name}. Revisa tu archivo .env.local (ver .env.example).`,
    );
  }
  return value;
}

/**
 * URL pública de la app (sin "/" final). QStash la usa para llamar a los jobs.
 * En desarrollo: la URL del túnel. En Vercel se deduce de VERCEL_URL si no se define.
 */
export function getAppUrl(): string {
  const explicit = process.env.APP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  throw new ConfigError("Falta la variable de entorno APP_URL (URL pública de la app).");
}

export type TemplateParamFormat = "named" | "positional";

export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  templateLanguage: string;
  paramFormat: TemplateParamFormat;
}

export function getWhatsAppConfig(): WhatsAppConfig {
  return {
    accessToken: requireEnv("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: requireEnv("WHATSAPP_PHONE_NUMBER_ID"),
    apiVersion: process.env.WHATSAPP_API_VERSION || "v26.0",
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "es",
    paramFormat:
      process.env.WHATSAPP_TEMPLATE_PARAM_FORMAT === "named" ? "named" : "positional",
  };
}
