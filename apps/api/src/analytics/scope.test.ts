import { describe, expect, it } from "vitest";
import type { AccessGrant } from "../access-policy";
import { parseAnalyticsRange, resolveAnalyticsScope } from "./scope";

const grant = (role: AccessGrant["role"], branchId: string | null): AccessGrant => ({ id: `${role}-${branchId}`, role, branchId });

describe("resolveAnalyticsScope", () => {
  it("accepts a requested branch inside the grant list", () => {
    const result = resolveAnalyticsScope([grant("manager", "b1")], "b1");
    expect(result).toEqual({ ok: true, branchId: "b1" });
  });

  it("denies a requested branch outside the grant list with 403", () => {
    const result = resolveAnalyticsScope([grant("technician", "b1")], "b2");
    expect(result).toEqual({ ok: false, status: 403, code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" });
  });

  it("returns tenant-wide scope for an owner when no branch requested", () => {
    expect(resolveAnalyticsScope([grant("owner", null)])).toEqual({ ok: true, branchId: undefined });
  });

  it("auto-scopes to the single granted branch", () => {
    expect(resolveAnalyticsScope([grant("technician", "b1")])).toEqual({ ok: true, branchId: "b1" });
  });

  it("asks for a branch when several are granted and none requested", () => {
    const result = resolveAnalyticsScope([grant("technician", "b1"), grant("technician", "b2")]);
    expect(result).toEqual({ ok: false, status: 400, code: "BRANCH_REQUIRED", message: "Choose a branch before loading analytics" });
  });
});

describe("parseAnalyticsRange", () => {
  const now = new Date("2026-08-26T00:00:00Z");

  it("defaults to the last 30 days", () => {
    const result = parseAnalyticsRange(undefined, undefined, now);
    expect(result.ok && result.value).toEqual({ from: "2026-07-27", to: "2026-08-26" });
  });

  it("accepts explicit ISO dates", () => {
    expect(parseAnalyticsRange("2026-08-01", "2026-08-10", now)).toEqual({
      ok: true,
      value: { from: "2026-08-01", to: "2026-08-10" }
    });
  });

  it("rejects malformed dates and inverted ranges", () => {
    expect(parseAnalyticsRange("2026-13-01", "2026-08-10", now).ok).toBe(false);
    expect(parseAnalyticsRange("2026-08-10", "2026-08-01", now)).toEqual({
      ok: false, status: 400, code: "INVALID_RANGE", message: "from must be before to"
    });
  });

  it("caps the window at 90 days", () => {
    const result = parseAnalyticsRange("2026-01-01", "2026-08-26", now);
    expect(result).toEqual({ ok: false, status: 400, code: "RANGE_TOO_LONG", message: "Analytics range is capped at 90 days" });
  });
});
