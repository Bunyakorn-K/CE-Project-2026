import { describe, expect, it } from "vitest";
import { buildGrantRequest, canSubmitGrant } from "./admin-grant";

describe("buildGrantRequest", () => {
  it("sends one branch for a manager", () => {
    expect(buildGrantRequest({ email: "mgr@example.com", role: "manager", branchId: "branch-01" })).toEqual({
      ok: true,
      body: { email: "mgr@example.com", role: "manager", branchId: "branch-01" }
    });
  });

  it("sends one branch for a technician", () => {
    expect(buildGrantRequest({ email: "tech@example.com", role: "technician", branchId: "branch-02" })).toEqual({
      ok: true,
      body: { email: "tech@example.com", role: "technician", branchId: "branch-02" }
    });
  });

  it("drops the branch for an owner, because owner is tenant-wide", () => {
    // The form disables the branch picker for an owner, but the stale value is
    // still in state. Carrying it would be rejected by the API, and quietly
    // widening an owner grant is the failure that hands out more access than
    // intended.
    expect(buildGrantRequest({ email: "owner@example.com", role: "owner", branchId: "branch-01" })).toEqual({
      ok: true,
      body: { email: "owner@example.com", role: "owner", branchId: null }
    });
  });

  it("refuses a manager grant with no branch instead of sending a tenant-wide one", () => {
    // The dangerous direction: resolving an empty branch to `null` would make
    // this identical to an owner grant and hand a manager every branch.
    expect(buildGrantRequest({ email: "mgr@example.com", role: "manager", branchId: "" })).toEqual({
      ok: false,
      reason: "branch-required"
    });
  });

  it("refuses a technician grant with no branch", () => {
    expect(buildGrantRequest({ email: "tech@example.com", role: "technician", branchId: "" })).toEqual({
      ok: false,
      reason: "branch-required"
    });
  });

  it("refuses an empty or whitespace address", () => {
    expect(buildGrantRequest({ email: "", role: "manager", branchId: "branch-01" })).toEqual({
      ok: false,
      reason: "email-required"
    });
    expect(buildGrantRequest({ email: "   ", role: "manager", branchId: "branch-01" })).toEqual({
      ok: false,
      reason: "email-required"
    });
  });

  it("trims the address, so a pasted value is not rejected as unknown", () => {
    expect(buildGrantRequest({ email: "  mgr@example.com  ", role: "manager", branchId: "b1" })).toEqual({
      ok: true,
      body: { email: "mgr@example.com", role: "manager", branchId: "b1" }
    });
  });

  it("lets an owner grant proceed with no branch chosen", () => {
    expect(canSubmitGrant({ email: "owner@example.com", role: "owner", branchId: "" })).toBe(true);
  });
});

describe("canSubmitGrant", () => {
  it("agrees with the payload builder in every case", () => {
    // The button's disabled state and the request body come from one decision,
    // so a form that looks submittable but cannot submit — or the reverse — is
    // the bug this guards.
    const cases = [
      { email: "a@example.com", role: "owner" as const, branchId: "" },
      { email: "a@example.com", role: "owner" as const, branchId: "b1" },
      { email: "a@example.com", role: "manager" as const, branchId: "b1" },
      { email: "a@example.com", role: "manager" as const, branchId: "" },
      { email: "a@example.com", role: "technician" as const, branchId: "" },
      { email: "", role: "manager" as const, branchId: "b1" }
    ];

    for (const input of cases) {
      expect(canSubmitGrant(input)).toBe(buildGrantRequest(input).ok);
    }
  });
});
