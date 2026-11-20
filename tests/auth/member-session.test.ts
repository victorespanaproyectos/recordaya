/**
 * requireMember / getCurrentMember con la base real: 3 roles, sin membresía, legacy y multi-negocio (T-03.3).
 * Crea usuarios temporales en Supabase Auth y los borra al terminar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE } from "@/lib/panel/session-token";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const jar = new Map<string, string>();
let currentUserId: string | null = null;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
vi.mock("@/lib/auth/supabase-server", () => ({
  isSupabaseAuthConfigured: () => true,
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUserId ? { id: currentUserId } : null }, error: null }) },
  }),
}));

import { BUSINESS_COOKIE, getCurrentMember, requireMember } from "@/lib/auth/session";
import { hasPanelSession, requirePanelSession } from "@/lib/panel/auth";

const db = () => getSupabaseAdmin();
const digestOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e);
  }
  return "OK";
};
const REDIRECT_LOGIN = "NEXT_REDIRECT;replace;/login;307;";
const FORBIDDEN = "NEXT_HTTP_ERROR_FALLBACK;403";

describe.skipIf(!hasDb)("requireMember", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  const users: Record<string, string> = {};
  const authUserIds: string[] = [];

  async function addUser(key: string, business: TestBusiness, role: string, status = "active") {
    let id = users[key];
    if (!id) {
      const { data, error } = await db().auth.admin.createUser({
        email: `${key}-${RUN_ID}@example.test`,
        email_confirm: true,
      });
      if (error) throw error;
      id = data.user.id;
      users[key] = id;
      authUserIds.push(id);
    }
    const { error } = await db().from("business_members").insert({
      business_id: business.id,
      user_id: id,
      email: `${key}-${RUN_ID}-${business.id.slice(0, 4)}@example.test`,
      display_name: key,
      role,
      status,
    });
    if (error) throw error;
    return id;
  }

  beforeAll(async () => {
    a = await createTestBusiness();
    b = await createTestBusiness();
    await addUser("owner", a, "owner");
    await addUser("admin", a, "admin");
    await addUser("operator", a, "operator");
    await addUser("invited", a, "operator", "invited");
    await addUser("disabled", a, "admin", "disabled");
    await addUser("multi", a, "operator");
    await addUser("multi", b, "admin");
    const { data } = await db().auth.admin.createUser({ email: `nomember-${RUN_ID}@example.test`, email_confirm: true });
    users.nomember = data.user!.id;
    authUserIds.push(users.nomember);
  }, 60_000);

  afterAll(async () => {
    await cleanup(a?.id);
    await cleanup(b?.id);
    for (const id of authUserIds) await db().auth.admin.deleteUser(id);
  }, 60_000);

  beforeEach(() => {
    jar.clear();
    currentUserId = null;
    delete process.env.PANEL_LEGACY_LOGIN;
  });

  it("sin sesión → redirige a /login", async () => {
    expect(await digestOf(requireMember("operator"))).toBe(REDIRECT_LOGIN);
    expect(await getCurrentMember()).toBeNull();
    expect(await hasPanelSession()).toBe(false);
  });

  it.each([
    ["owner", { operator: true, admin: true, owner: true }],
    ["admin", { operator: true, admin: true, owner: false }],
    ["operator", { operator: true, admin: false, owner: false }],
  ] as const)("rol %s: acceso según el rol mínimo", async (key, expected) => {
    currentUserId = users[key];
    for (const min of ["operator", "admin", "owner"] as const) {
      const result = await digestOf(requireMember(min));
      expect(result, `${key} pide ${min}`).toBe(expected[min] ? "OK" : FORBIDDEN);
    }
    const member = await requireMember("operator");
    expect(member).toMatchObject({ role: key, businessId: a.id, userId: users[key], legacy: false, displayName: key });
    expect(member.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("usuario sin membresía → 403", async () => {
    currentUserId = users.nomember;
    expect(await digestOf(requireMember("operator"))).toBe(FORBIDDEN);
    expect(await getCurrentMember()).toBeNull();
  });

  it("miembro invitado (aún sin activar) o desactivado → 403", async () => {
    for (const key of ["invited", "disabled"]) {
      currentUserId = users[key];
      expect(await digestOf(requireMember("operator")), key).toBe(FORBIDDEN);
    }
  });

  it("requirePanelSession deja pasar a un operador y bloquea sin sesión", async () => {
    currentUserId = users.operator;
    expect(await digestOf(requirePanelSession())).toBe("OK");
    currentUserId = null;
    expect(await digestOf(requirePanelSession())).toBe(REDIRECT_LOGIN);
  });

  it("varios negocios: usa el primero; la cookie ry_business solo vale si es una membresía real", async () => {
    currentUserId = users.multi;
    expect((await requireMember("operator")).businessId).toBe(a.id);

    jar.set(BUSINESS_COOKIE, b.id);
    const inB = await requireMember("operator");
    expect(inB).toMatchObject({ businessId: b.id, role: "admin" });

    jar.set(BUSINESS_COOKIE, "00000000-0000-0000-0000-000000000000");
    expect((await requireMember("operator")).businessId).toBe(a.id);

    // Un usuario de un solo negocio no puede "elegir" otro con la cookie.
    currentUserId = users.operator;
    jar.set(BUSINESS_COOKIE, b.id);
    expect((await requireMember("operator")).businessId).toBe(a.id);
  });

  describe("sesión legacy (contraseña compartida)", () => {
    it("con PANEL_LEGACY_LOGIN sin definir → miembro virtual owner del negocio más antiguo", async () => {
      jar.set(SESSION_COOKIE, await createSessionToken());
      const { data } = await db().from("businesses").select("id").order("created_at").limit(1);
      const member = await requireMember("owner");
      expect(member).toEqual({
        id: null, userId: null, businessId: data![0].id, role: "owner", displayName: "Demo", legacy: true,
      });
      expect(await hasPanelSession()).toBe(true);
    });

    it("con PANEL_LEGACY_LOGIN=false la cookie legacy deja de valer", async () => {
      process.env.PANEL_LEGACY_LOGIN = "false";
      jar.set(SESSION_COOKIE, await createSessionToken());
      expect(await digestOf(requireMember("operator"))).toBe(REDIRECT_LOGIN);
    });

    it("cookie legacy inválida → /login", async () => {
      jar.set(SESSION_COOKIE, "123.firma-falsa");
      expect(await digestOf(requireMember("operator"))).toBe(REDIRECT_LOGIN);
    });

    it("la sesión de Supabase tiene prioridad sobre la legacy", async () => {
      jar.set(SESSION_COOKIE, await createSessionToken());
      currentUserId = users.operator;
      expect(await requireMember("operator")).toMatchObject({ role: "operator", legacy: false });
    });
  });
});
