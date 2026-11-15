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
