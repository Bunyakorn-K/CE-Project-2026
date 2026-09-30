import { describe, expect, it } from "vitest";
import { canViewRevenue, isOwner, type AccessGrantLike } from "./access";
import type { AuthUser } from "./atoms/auth";

const user = (...grants: AccessGrantLike[]): AuthUser => ({
  id: "u1",
  name: "U",
  email: "u@e.com",
  roles: grants.map((g) => g.role),
  grants
});

const owner = user({ role: "owner", branchId: null });
const manager = user({ role: "manager", branchId: "b1" });
const technician = user({ role: "technician", branchId: "b2" });

describe("isOwner", () => {
  it("grants access administration to an owner", () => {
    expect(isOwner(owner)).toBe(true);
  });

  it("denies a manager", () => {
    expect(isOwner(manager)).toBe(false);
  });

  it("denies a technician", () => {
    expect(isOwner(technician)).toBe(false);
  });

  it("denies a signed-out user rather than defaulting to owner", () => {
    expect(isOwner(null)).toBe(false);
  });

  it("grants owner when any one grant is owner, alongside other roles", () => {
    expect(isOwner(user({ role: "technician", branchId: "b2" }, { role: "owner", branchId: null }))).toBe(true);
  });
});

describe("canViewRevenue", () => {
  it("allows an owner", () => {
    expect(canViewRevenue(owner)).toBe(true);
  });

  it("allows a manager", () => {
    expect(canViewRevenue(manager)).toBe(true);
  });

  it("denies a technician", () => {
    expect(canViewRevenue(technician)).toBe(false);
  });

  it("denies a signed-out user", () => {
    expect(canViewRevenue(null)).toBe(false);
  });
});
