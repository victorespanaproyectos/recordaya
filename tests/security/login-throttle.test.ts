/** Límite de intentos del login legacy (07 §19.2): 10 fallos por IP en 15 min. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { dbConfigured } from "../helpers/supabase-test";

const state = { ip: `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": `${state.ip}, 10.0.0.1` }),
  cookies: async () => ({ set: cookieSet, delete: vi.fn() }),
}));

import { loginAction } from "@/app/login/actions";
import { isLoginBlocked, LOGIN_MAX_ATTEMPTS, loginThrottleKey, recordFailedLogin } from "@/lib/auth/login-throttle";
import { hashIp } from "@/lib/security/ip";

const db = () => getSupabaseAdmin();
const form = (password: string) => {
  const f = new FormData();
  f.set("password", password);
  return f;
};

async function migrated(): Promise<boolean> {
  if (!dbConfigured()) return false;
  const { error } = await db().from("login_attempts").select("id").limit(1);
  if (error) console.warn("AVISO: la migración 0012 no está aplicada; se omiten las pruebas del límite de login (aplica supabase/apply/dev-0012.sql).");
  return !error;
}
const ready = await migrated();

describe("hashIp", () => {
  it("es determinista, depende de la sal y no contiene la IP", () => {
    expect(hashIp("1.2.3.4", "s1")).toBe(hashIp("1.2.3.4", "s1"));
    expect(hashIp("1.2.3.4", "s1")).not.toBe(hashIp("1.2.3.4", "s2"));
    expect(hashIp("1.2.3.4", "s1")).not.toContain("1.2.3.4");
  });
});

describe.skipIf(!ready)("S-11 · límite de intentos del login legacy", () => {
  beforeEach(async () => {
    state.ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    cookieSet.mockClear();
  });
  it("la clave sale de la primera IP de x-forwarded-for, con hash", async () => {
    const key = await loginThrottleKey();
    expect(key).toBe(hashIp(state.ip, process.env.AUDIT_IP_SALT ?? "recordaya-login"));
    expect(key).not.toContain(state.ip);
  });

  it("10 contraseñas incorrectas → el intento 11 queda bloqueado, incluso con la contraseña correcta", async () => {
    const key = (await loginThrottleKey())!;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) await recordFailedLogin(key);
    expect(await isLoginBlocked(key)).toBe(true);
    const r = await loginAction({}, form(process.env.PANEL_PASSWORD!));
    expect(r.error).toMatch(/Demasiados intentos/);
    expect(cookieSet).not.toHaveBeenCalled();
    await db().from("login_attempts").delete().eq("ip_hash", key);
  }, 60_000);

  it("un fallo se registra; 9 fallos todavía no bloquean; los de hace más de 15 min no cuentan", async () => {
    const key = (await loginThrottleKey())!;
    expect((await loginAction({}, form("incorrecta"))).error).toBe("Contraseña incorrecta.");
    expect((await db().from("login_attempts").select("id").eq("ip_hash", key)).data).toHaveLength(1);
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS - 2; i++) await recordFailedLogin(key);
    expect(await isLoginBlocked(key)).toBe(false);

    await db().from("login_attempts").update({ attempted_at: new Date(Date.now() - 16 * 60_000).toISOString() }).eq("ip_hash", key);
    await recordFailedLogin(key);
    expect(await isLoginBlocked(key)).toBe(false);
    await db().from("login_attempts").delete().eq("ip_hash", key);
  }, 60_000);

  it("un ingreso correcto limpia los intentos fallidos de esa IP", async () => {
    const key = (await loginThrottleKey())!;
    await recordFailedLogin(key);
    await recordFailedLogin(key);
    await expect(loginAction({}, form(process.env.PANEL_PASSWORD!))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(cookieSet).toHaveBeenCalledOnce();
    expect((await db().from("login_attempts").select("id").eq("ip_hash", key)).data).toHaveLength(0);
  }, 60_000);

  it("otra IP no queda bloqueada por los fallos de la primera", async () => {
    const key = (await loginThrottleKey())!;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) await recordFailedLogin(key);
    state.ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    expect(await isLoginBlocked((await loginThrottleKey())!)).toBe(false);
    await db().from("login_attempts").delete().eq("ip_hash", key);
  });
});
