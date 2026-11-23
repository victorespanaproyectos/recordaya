import { afterAll, beforeAll } from "vitest";
import { DAY_MS, dayKey } from "@/lib/dates";
import { cleanup, createTestBusiness, dbConfigured, type TestBusiness } from "./supabase-test";

export const hasDb = dbConfigured();

/** Crea un negocio propio para el archivo de pruebas y lo borra al terminar. */
export function setupTestBusiness(): { current: TestBusiness } {
  const holder = {} as { current: TestBusiness };
  beforeAll(async () => {
    if (!hasDb) return;
    holder.current = await createTestBusiness();
  });
  afterAll(async () => {
    if (!hasDb) return;
    await cleanup(holder.current?.id);
  });
  return holder;
}

export const inDays = (n: number, hoursOffset = 0) =>
  new Date(Date.now() + n * DAY_MS + hoursOffset * 3_600_000);

/** Fecha/hora locales del negocio para un instante (formato de los formularios del panel). */
export function localDateTime(date: Date, timeZone: string) {
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
  return { date: dayKey(date, timeZone), time };
}

export const adminAuth = () => ({ authorization: `Bearer ${process.env.ADMIN_API_KEY}` });
