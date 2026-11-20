/**
 * Servicio de miembros (T-03.4) contra la base real: invitar, activar en el primer login,
 * cambiar rol/estado, regla del último owner, aislamiento por negocio y liberación de conversaciones.
 * El envío real de emails se reemplaza por un espía (no se manda nada).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateInvitedMembers,
  inviteMember,
  listMembers,
  removeMember,
  setAvailability,
  updateMember,
} from "@/lib/auth/members";
import type { Member } from "@/lib/auth/session";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { cleanup, createTestBusiness, dbConfigured, RUN_ID, type TestBusiness } from "../helpers/supabase-test";

const hasDb = dbConfigured();
const db = () => getSupabaseAdmin();

describe.skipIf(!hasDb)("servicio de miembros", () => {
  let a: TestBusiness;
  let b: TestBusiness;
  const authUserIds: string[] = [];
  let seq = 0;
  let invite: ReturnType<typeof vi.spyOn>;

  const email = (tag: string) => `${tag}-${RUN_ID}-${seq++}@example.test`;
  const actorOf = (role: Member["role"], businessId: string, id: string | null = null): Member => ({
    id, userId: null, businessId, role, displayName: role, legacy: id === null,
  });

  async function insertMember(business: TestBusiness, role: string, status = "active", withUser = false) {
    let userId: string | null = null;
    const addr = email(role);
    if (withUser) {
      const { data, error } = await db().auth.admin.createUser({ email: addr, email_confirm: true });
      if (error) throw error;
      userId = data.user.id;
      authUserIds.push(userId);
    }
    const { data, error } = await db()
      .from("business_members")
      .insert({ business_id: business.id, user_id: userId, email: addr, display_name: role, role, status })
      .select("id")
      .single();
    if (error) throw error;
    return { id: data.id as string, email: addr, userId };
  }

  const statusOf = async (id: string) =>
    (await db().from("business_members").select("role, status, user_id").eq("id", id).single()).data!;

  beforeAll(async () => {
    process.env.APP_URL = "https://app.example.test";
    a = await createTestBusiness();
    b = await createTestBusiness();
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanup(a?.id);
    await cleanup(b?.id);
    for (const id of authUserIds) await db().auth.admin.deleteUser(id);
  }, 60_000);

  beforeEach(() => {
    // El espía se crea en cada prueba: nunca debe salir un email real.
    invite = vi.spyOn(db().auth.admin, "inviteUserByEmail");
    // mockReset restauraría la función real (y enviaría emails): solo se limpian las llamadas y se fija la respuesta.
    invite.mockClear();
    invite.mockImplementation((async () => ({ data: {}, error: null })) as never);
  });

  describe("inviteMember", () => {
    it("owner invita: crea la fila invited, envía el email con redirect y audita", async () => {
      const owner = await insertMember(a, "owner");
      const target = email("nuevo").toUpperCase();
      const member = await inviteMember(actorOf("owner", a.id, owner.id), { email: ` ${target} `, name: " Ana ", role: "operator" });

      expect(member).toMatchObject({ email: target.toLowerCase(), displayName: "Ana", role: "operator", status: "invited", userId: null });
      expect(invite).toHaveBeenCalledWith(target.toLowerCase(), { redirectTo: "https://app.example.test/auth/confirmar" });
      const { data: logs } = await db().from("audit_log").select("action, actor_member_id, target_id").eq("target_id", member.id);
      expect(logs).toEqual([{ action: "member.invited", actor_member_id: owner.id, target_id: member.id }]);
    });

    it("admin puede invitar operator/admin pero no owner", async () => {
      const admin = actorOf("admin", a.id, (await insertMember(a, "admin")).id);
      await expect(inviteMember(admin, { email: email("x"), name: "X", role: "admin" })).resolves.toBeTruthy();
      await expect(inviteMember(admin, { email: email("y"), name: "Y", role: "owner" })).rejects.toMatchObject({ status: 403 });
    });

    it("operator no puede invitar", async () => {
      const op = actorOf("operator", a.id, (await insertMember(a, "operator")).id);
      await expect(inviteMember(op, { email: email("z"), name: "Z", role: "operator" })).rejects.toMatchObject({ status: 403 });
      expect(invite).not.toHaveBeenCalled();
    });

    it("valida email, nombre y rol; rechaza duplicados", async () => {
      const owner = actorOf("owner", a.id);
      await expect(inviteMember(owner, { email: "sin-arroba", name: "X", role: "operator" })).rejects.toMatchObject({ status: 400 });
      await expect(inviteMember(owner, { email: email("v"), name: "  ", role: "operator" })).rejects.toMatchObject({ status: 400 });
      await expect(inviteMember(owner, { email: email("v"), name: "V", role: "root" as never })).rejects.toMatchObject({ status: 400 });
      const dup = email("dup");
      await inviteMember(owner, { email: dup, name: "D", role: "operator" });
      await expect(inviteMember(owner, { email: dup, name: "D", role: "operator" })).rejects.toMatchObject({ status: 409 });
    });

    it("si el email no se puede enviar, no deja la fila", async () => {
      invite.mockImplementation((async () => ({ data: {}, error: { message: "smtp down" } })) as never);
      const addr = email("fallo");
      await expect(inviteMember(actorOf("owner", a.id), { email: addr, name: "F", role: "operator" })).rejects.toMatchObject({ status: 400 });
      const { data } = await db().from("business_members").select("id").eq("email", addr);
      expect(data).toEqual([]);
    });

    it("si el email ya tiene cuenta, avisa (409) y no deja la fila", async () => {
      invite.mockImplementation((async () => ({ data: {}, error: { message: "A user with this email address has already been registered" } })) as never);
      const addr = email("existente");
      await expect(inviteMember(actorOf("owner", a.id), { email: addr, name: "E", role: "operator" })).rejects.toMatchObject({ status: 409 });
      const { data } = await db().from("business_members").select("id").eq("email", addr);
      expect(data).toEqual([]);
    });
  });

  describe("activateInvitedMembers (primer login)", () => {
    it("enlaza user_id y activa solo con email confirmado; es idempotente", async () => {
      const m = await insertMember(a, "operator", "invited");
      const user = { id: crypto.randomUUID(), email: m.email.toUpperCase() };

      expect(await activateInvitedMembers({ ...user, email_confirmed_at: null })).toBe(0);
      expect((await statusOf(m.id)).status).toBe("invited");

      const { data } = await db().auth.admin.createUser({ email: m.email, email_confirm: true });
      authUserIds.push(data.user!.id);
      expect(await activateInvitedMembers({ id: data.user!.id, email: m.email.toUpperCase(), email_confirmed_at: new Date().toISOString() })).toBe(1);
      expect(await statusOf(m.id)).toMatchObject({ status: "active", user_id: data.user!.id });
      expect(await activateInvitedMembers({ id: data.user!.id, email: m.email, email_confirmed_at: new Date().toISOString() })).toBe(0);
    });

    it("no reactiva a un miembro desactivado", async () => {
      const m = await insertMember(a, "operator", "disabled");
      expect(await activateInvitedMembers({ id: crypto.randomUUID(), email: m.email, email_confirmed_at: "2026-01-01" })).toBe(0);
      expect((await statusOf(m.id)).status).toBe("disabled");
    });
  });

  describe("updateMember", () => {
    it("owner cambia rol y máximo; audita el diff", async () => {
      const owner = actorOf("owner", a.id, (await insertMember(a, "owner")).id);
      const op = await insertMember(a, "operator");
      const updated = await updateMember(owner, op.id, { role: "admin", maxConcurrent: 8 });
      expect(updated).toMatchObject({ role: "admin", maxConcurrent: 8 });
      const { data } = await db().from("audit_log").select("action, diff").eq("target_id", op.id);
      expect(data).toEqual([
        { action: "member.role_changed", diff: { role: { from: "operator", to: "admin" }, max_concurrent: { from: 5, to: 8 } } },
      ]);
    });

    it("valida max_concurrent", async () => {
      const owner = actorOf("owner", a.id);
      const op = await insertMember(a, "operator");
      for (const v of [0, 51, 2.5]) {
        await expect(updateMember(owner, op.id, { maxConcurrent: v })).rejects.toMatchObject({ status: 400 });
      }
    });

    it("un admin no toca owners ni asciende a nadie a owner", async () => {
      const admin = actorOf("admin", a.id, (await insertMember(a, "admin")).id);
      const owner = await insertMember(a, "owner");
      const op = await insertMember(a, "operator");
      await expect(updateMember(admin, owner.id, { maxConcurrent: 3 })).rejects.toMatchObject({ status: 403 });
      await expect(updateMember(admin, op.id, { role: "owner" })).rejects.toMatchObject({ status: 403 });
      await expect(updateMember(admin, op.id, { role: "admin" })).resolves.toMatchObject({ role: "admin" });
    });

    it("un operator no gestiona a nadie", async () => {
      const op = actorOf("operator", a.id, (await insertMember(a, "operator")).id);
      const other = await insertMember(a, "operator");
      await expect(updateMember(op, other.id, { maxConcurrent: 3 })).rejects.toMatchObject({ status: 403 });
    });

    it("un miembro de otro negocio no existe para el actor", async () => {
      const foreign = await insertMember(b, "operator");
      await expect(updateMember(actorOf("owner", a.id), foreign.id, { role: "admin" })).rejects.toMatchObject({ status: 404 });
      expect((await statusOf(foreign.id)).role).toBe("operator");
    });

    it("no se puede activar una invitación pendiente a mano", async () => {
      const inv = await insertMember(a, "operator", "invited");
      await expect(updateMember(actorOf("owner", a.id), inv.id, { status: "active" })).rejects.toMatchObject({ status: 400 });
    });

    it("desactivar y reactivar: sin usuario vuelve a invited, con usuario a active", async () => {
      const owner = actorOf("owner", a.id);
      const linked = await insertMember(a, "operator", "active", true);
      expect(await updateMember(owner, linked.id, { status: "disabled" })).toMatchObject({ status: "disabled" });
      expect(await updateMember(owner, linked.id, { status: "active" })).toMatchObject({ status: "active" });

      const unlinked = await insertMember(a, "operator", "disabled");
      expect(await updateMember(owner, unlinked.id, { status: "active" })).toMatchObject({ status: "invited" });
    });
  });

  describe("regla del último owner", () => {
    let c: TestBusiness;
    beforeAll(async () => {
      c = await createTestBusiness();
    });
    afterAll(async () => {
      await cleanup(c.id);
    });

    it("el único owner no puede degradarse, desactivarse ni eliminarse; con dos owners sí uno", async () => {
      const first = await insertMember(c, "owner");
      const actor = actorOf("owner", c.id, first.id);
      const msg = { status: 409 };

      await expect(updateMember(actor, first.id, { role: "admin" })).rejects.toMatchObject(msg);
      await expect(updateMember(actor, first.id, { status: "disabled" })).rejects.toMatchObject(msg);
      await expect(removeMember(actor, first.id)).rejects.toMatchObject(msg);
      expect(await statusOf(first.id)).toMatchObject({ role: "owner", status: "active" });

      const second = await insertMember(c, "owner");
      await expect(updateMember(actor, second.id, { role: "admin" })).resolves.toMatchObject({ role: "admin" });
      // Otra vez queda uno solo.
      await expect(updateMember(actor, first.id, { role: "operator" })).rejects.toMatchObject(msg);
    });

    it("un owner desactivado o invitado no cuenta como owner activo", async () => {
      const d = await createTestBusiness();
      try {
        const only = await insertMember(d, "owner");
        await insertMember(d, "owner", "disabled");
        await insertMember(d, "owner", "invited");
        await expect(updateMember(actorOf("owner", d.id), only.id, { status: "disabled" })).rejects.toMatchObject({ status: 409 });
      } finally {
        await cleanup(d.id);
      }
    });
  });

  describe("conversaciones al desactivar o eliminar", () => {
    async function humanConversation(business: TestBusiness, memberId: string) {
      const { data: contact } = await db()
        .from("chat_contacts")
        .insert({ business_id: business.id, channel: "whatsapp", external_id: `5989${Math.floor(Math.random() * 1e7)}` })
        .select("id")
        .single();
      const { data: conv } = await db()
        .from("conversations")
        .insert({ business_id: business.id, contact_id: contact!.id, channel: "whatsapp", status: "pending_human" })
        .select("id")
        .single();
      const { data: claimed } = await db().rpc("claim_conversation", {
        p_conversation_id: conv!.id, p_business_id: business.id, p_member_id: memberId,
      });
      expect(claimed).toBe(true);
      return conv!.id as string;
    }

    const conversation = async (id: string) =>
      (await db().from("conversations").select("status, assigned_member_id, assigned_at").eq("id", id).single()).data!;
    const assignments = async (id: string) =>
      (await db().from("conversation_assignments").select("released_at, release_reason").eq("conversation_id", id)).data!;

    it("desactivar libera sus conversaciones human a pending_human", async () => {
      const op = await insertMember(a, "operator");
      const other = await insertMember(a, "operator");
      const mine = await humanConversation(a, op.id);
      const theirs = await humanConversation(a, other.id);

      await updateMember(actorOf("owner", a.id), op.id, { status: "disabled" });

      expect(await conversation(mine)).toEqual({ status: "pending_human", assigned_member_id: null, assigned_at: null });
      expect(await assignments(mine)).toEqual([{ released_at: expect.any(String), release_reason: "member_disabled" }]);
      const { data: events } = await db().from("conversation_events").select("type, to_status").eq("conversation_id", mine).eq("type", "released");
      expect(events).toEqual([{ type: "released", to_status: "pending_human" }]);
      // La de otro miembro no se toca.
      expect(await conversation(theirs)).toMatchObject({ status: "human", assigned_member_id: other.id });
    });

    it("eliminar libera las conversaciones y borra la fila", async () => {
      const op = await insertMember(a, "operator");
      const conv = await humanConversation(a, op.id);
      await removeMember(actorOf("owner", a.id), op.id);
      expect(await conversation(conv)).toMatchObject({ status: "pending_human", assigned_member_id: null });
      expect((await db().from("business_members").select("id").eq("id", op.id)).data).toEqual([]);
      const { data: logs } = await db().from("audit_log").select("action").eq("target_id", op.id);
      expect(logs).toEqual([{ action: "member.removed" }]);
    });
  });

  describe("listMembers y disponibilidad", () => {
    it("lista solo los miembros del negocio del actor", async () => {
      const mineB = await insertMember(b, "operator");
      const list = await listMembers(actorOf("admin", a.id));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((m) => m.businessId === a.id)).toBe(true);
      expect(list.find((m) => m.id === mineB.id)).toBeUndefined();
    });

    it("cada miembro activo cambia su propia disponibilidad; la sesión legacy no", async () => {
      const m = await insertMember(a, "operator");
      await setAvailability(actorOf("operator", a.id, m.id), true);
      expect((await db().from("business_members").select("is_available").eq("id", m.id).single()).data).toEqual({ is_available: true });
      await expect(setAvailability(actorOf("owner", a.id, null), true)).rejects.toMatchObject({ status: 400 });
      const inactive = await insertMember(a, "operator", "disabled");
      await expect(setAvailability(actorOf("operator", a.id, inactive.id), true)).rejects.toMatchObject({ status: 404 });
    });
  });
});
