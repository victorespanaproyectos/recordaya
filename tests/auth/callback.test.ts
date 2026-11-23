import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = {
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
};
vi.mock("@/lib/auth/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ auth })),
}));

import { GET } from "@/app/auth/callback/route";

const call = (query: string) => GET(new NextRequest(`http://localhost:3000/auth/callback?${query}`));
const location = (res: Response) => {
  const url = new URL(res.headers.get("location")!);
  return url.pathname + url.search;
};

beforeEach(() => {
  auth.exchangeCodeForSession.mockReset().mockResolvedValue({ error: null });
  auth.verifyOtp.mockReset().mockResolvedValue({ error: null });
});

describe("GET /auth/callback", () => {
  it("código válido → /panel", async () => {
    const res = await call("code=abc");
    expect(auth.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(location(res)).toBe("/panel");
  });

  it("código inválido → /login?error=enlace", async () => {
    auth.exchangeCodeForSession.mockResolvedValue({ error: { message: "x" } });
    expect(location(await call("code=malo"))).toBe("/login?error=enlace");
  });

  it("sin parámetros → /login?error=enlace", async () => {
    expect(location(await call(""))).toBe("/login?error=enlace");
  });

  it("invitación (token_hash + type=invite) → definir contraseña", async () => {
    const res = await call("token_hash=h&type=invite");
    expect(auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "h", type: "invite" });
    expect(location(res)).toBe("/auth/definir-contrasena");
  });

  it("recuperación → definir contraseña; enlace mágico → panel", async () => {
    expect(location(await call("token_hash=h&type=recovery"))).toBe("/auth/definir-contrasena");
    expect(location(await call("token_hash=h&type=magiclink"))).toBe("/panel");
  });

  it("token_hash con tipo desconocido o sin tipo → error", async () => {
    expect(location(await call("token_hash=h&type=otro"))).toBe("/login?error=enlace");
    expect(location(await call("token_hash=h"))).toBe("/login?error=enlace");
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it("OTP rechazado → error", async () => {
    auth.verifyOtp.mockResolvedValue({ error: { message: "expired" } });
    expect(location(await call("token_hash=h&type=invite"))).toBe("/login?error=enlace");
  });

  it("set_password=1 con código (PKCE) → definir contraseña", async () => {
    expect(location(await call("code=abc&set_password=1"))).toBe("/auth/definir-contrasena");
  });

  it("next solo admite rutas del panel (sin redirección abierta)", async () => {
    expect(location(await call("code=abc&next=/panel/turnos/1"))).toBe("/panel/turnos/1");
    expect(location(await call("code=abc&next=//evil.test"))).toBe("/panel");
    expect(location(await call("code=abc&next=https://evil.test"))).toBe("/panel");
  });

  it("una excepción del cliente → error, sin filtrar detalles", async () => {
    auth.exchangeCodeForSession.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(location(await call("code=abc"))).toBe("/login?error=enlace");
    err.mockRestore();
  });
});
