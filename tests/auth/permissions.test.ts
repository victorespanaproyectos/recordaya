import { describe, expect, it } from "vitest";
import { can, canManageRole, hasMinRole, type Permission, type Role } from "@/lib/auth/permissions";

const ROLES: Role[] = ["owner", "admin", "operator"];

/** Matriz de 06 §3.2: qué roles pueden cada cosa. */
const MATRIX: Record<Permission, Role[]> = {
  "agenda.view": ["owner", "admin", "operator"],
  "inbox.view": ["owner", "admin", "operator"],
  "conversation.handle_own": ["owner", "admin", "operator"],
  "conversation.reassign_or_close_any": ["owner", "admin"],
  "knowledge.view": ["owner", "admin", "operator"],
  "knowledge.write": ["owner", "admin"],
  "unanswered.view": ["owner", "admin", "operator"],
  "unanswered.resolve": ["owner", "admin"],
  "chatbot.configure": ["owner", "admin"],
  "chatbot.model_and_budget": ["owner"],
  "metrics.view": ["owner", "admin", "operator"],
  "usage_costs.view": ["owner", "admin"],
  "members.manage": ["owner", "admin"],
};

describe("can()", () => {
  for (const [permission, allowed] of Object.entries(MATRIX) as [Permission, Role[]][]) {
    it(`${permission}: ${allowed.join(", ")}`, () => {
      for (const role of ROLES) expect(can(role, permission), `${role}`).toBe(allowed.includes(role));
    });
  }
});

describe("hasMinRole()", () => {
  it("ordena operator < admin < owner", () => {
    expect(hasMinRole("operator", "operator")).toBe(true);
    expect(hasMinRole("operator", "admin")).toBe(false);
    expect(hasMinRole("admin", "operator")).toBe(true);
    expect(hasMinRole("admin", "owner")).toBe(false);
    expect(hasMinRole("owner", "admin")).toBe(true);
  });
});

describe("canManageRole()", () => {
  it("el admin gestiona admins y operadores, pero no owners", () => {
    expect(canManageRole("admin", "operator")).toBe(true);
    expect(canManageRole("admin", "admin")).toBe(true);
    expect(canManageRole("admin", "owner")).toBe(false);
  });
  it("el owner gestiona a todos; el operador a nadie", () => {
    for (const target of ROLES) {
      expect(canManageRole("owner", target)).toBe(true);
      expect(canManageRole("operator", target)).toBe(false);
    }
  });
});
