import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = { getClaims: vi.fn() };
vi.mock("@supabase/ssr", () => ({ createServerClient: vi.fn(() => ({ auth })) }));

import { proxy } from "@/proxy";
import { createSessionToken, SESSION_COOKIE } from "@/lib/panel/session-token";

const request = (cookie?: string) =>
  new NextRequest("http://localhost:3000/panel/turnos/x", { headers: cookie ? { cookie } : {} });
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";
const redirectsToLogin = (res: Response) =>
  res.status === 307 && new URL(res.headers.get("location")!).pathname === "/login";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
  delete process.env.PANEL_LEGACY_LOGIN;
  auth.getClaims.mockReset().mockResolvedValue({ data: null, error: null });
});
afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  delete process.env.PANEL_LEGACY_LOGIN;
});

describe("proxy", () => {
  it("sesión de Supabase válida → pasa", async () => {
    auth.getClaims.mockResolvedValue({ data: { claims: { sub: "u1" } }, error: null });
    expect(passes(await proxy(request()))).toBe(true);
  });

  it("sin sesión de Supabase ni cookie legacy → /login?next=…", async () => {
    const res = await proxy(request());
    expect(redirectsToLogin(res)).toBe(true);
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/panel/turnos/x");
  });

  it("cookie legacy válida → pasa (legacy activo por defecto)", async () => {
    const token = await createSessionToken();
    expect(passes(await proxy(request(`${SESSION_COOKIE}=${token}`)))).toBe(true);
  });

  it("cookie legacy válida pero PANEL_LEGACY_LOGIN=false → /login", async () => {
    process.env.PANEL_LEGACY_LOGIN = "false";
    const token = await createSessionToken();
    expect(redirectsToLogin(await proxy(request(`${SESSION_COOKIE}=${token}`)))).toBe(true);
  });

  it("cookie legacy inválida → /login", async () => {
    expect(redirectsToLogin(await proxy(request(`${SESSION_COOKIE}=1.firma-falsa`)))).toBe(true);
  });

  it("si getClaims falla, cae a la cookie legacy", async () => {
    auth.getClaims.mockRejectedValue(new Error("red"));
    const token = await createSessionToken();
    expect(passes(await proxy(request(`${SESSION_COOKIE}=${token}`)))).toBe(true);
    expect(redirectsToLogin(await proxy(request()))).toBe(true);
  });
});
