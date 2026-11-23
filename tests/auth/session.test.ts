import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const auth = { getUser: vi.fn(), setSession: vi.fn() };
vi.mock("@/lib/auth/supabase-server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ auth })),
}));

import { POST } from "@/app/auth/session/route";

const call = (body: unknown, origin: string | null = "http://localhost:3000") =>
  POST(
    new NextRequest("http://localhost:3000/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const tokens = { access_token: "a", refresh_token: "r" };

beforeEach(() => {
  auth.getUser.mockReset().mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
  auth.setSession.mockReset().mockResolvedValue({ error: null });
});

describe("POST /auth/session", () => {
  it("invitación válida → crea la sesión y manda a definir contraseña", async () => {
    const res = await call({ ...tokens, type: "invite" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/auth/definir-contrasena" });
    expect(auth.getUser).toHaveBeenCalledWith("a");
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: "a", refresh_token: "r" });
  });

  it("otro tipo → /panel", async () => {
    expect(await (await call({ ...tokens, type: "magiclink" })).json()).toEqual({ redirect: "/panel" });
  });

  it("origen ajeno o ausente → 403 y no toca Supabase", async () => {
    expect((await call(tokens, "https://evil.test")).status).toBe(403);
    expect((await call(tokens, null)).status).toBe(403);
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it("faltan tokens o JSON inválido → 400", async () => {
    expect((await call({ access_token: "a" })).status).toBe(400);
    expect((await call("no-json")).status).toBe(400);
  });

  it("token que Supabase rechaza → 401 y no crea sesión", async () => {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } });
    expect((await call(tokens)).status).toBe(401);
    expect(auth.setSession).not.toHaveBeenCalled();
  });

  it("falla al crear la sesión → 401", async () => {
    auth.setSession.mockResolvedValue({ error: { message: "x" } });
    expect((await call(tokens)).status).toBe(401);
  });

  it("excepción inesperada → 500 sin detalles", async () => {
    auth.getUser.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(tokens);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
    err.mockRestore();
  });
});
