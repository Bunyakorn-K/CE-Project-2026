import { describe, expect, it } from "vitest";
import { dashboardContext, dashboardSearch, isCalendarDate, presetRange } from "./dashboard-search";

const fallback = { from: "2026-09-25", to: "2026-10-01" };

describe("isCalendarDate", () => {
  it("accepts a real calendar date", () => {
    expect(isCalendarDate("2026-10-01")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true);
  });

  it("rejects a day that does not exist rather than rolling it over", () => {
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});

describe("dashboardContext", () => {
  it("resolves the URL's range, view and branch", () => {
    expect(dashboardContext({ view: "twin", branch: "b-1", from: "2026-09-01", to: "2026-09-07" }, fallback)).toEqual({
      view: "twin",
      branchId: "b-1",
      from: "2026-09-01",
      to: "2026-09-07",
      validRange: true
    });
  });

  it("falls back to the default window when the URL says nothing", () => {
    expect(dashboardContext({}, fallback)).toEqual({ view: "dashboard", branchId: "", ...fallback, validRange: true });
  });

  it("keeps the given end and fills the other when only one is supplied", () => {
    // "everything since the 1st" is a legitimate ask, not a broken range: the
    // given end stands and the other comes from the default.
    expect(dashboardContext({ from: "2026-09-01" }, fallback)).toEqual({
      view: "dashboard",
      branchId: "",
      from: "2026-09-01",
      to: fallback.to,
      validRange: true
    });
  });

  it("flags a half-range that cannot be completed into a valid window", () => {
    expect(dashboardContext({ from: "2026-10-20" }, fallback).validRange).toBe(false);
    expect(dashboardContext({ to: "2026-09-01" }, fallback).validRange).toBe(false);
  });

  it("flags a non-calendar date from the URL instead of querying it", () => {
    expect(dashboardContext({ from: "2026-02-31", to: "2026-10-01" }, fallback).validRange).toBe(false);
  });

  it("flags a reversed range rather than swapping it", () => {
    expect(dashboardContext({ from: "2026-10-05", to: "2026-09-25" }, fallback).validRange).toBe(false);
  });

  it("refuses an unrecognised view rather than passing it to the tab switch", () => {
    expect(dashboardContext({ view: "admin" as never }, fallback).view).toBe("dashboard");
  });
});

describe("dashboardSearch", () => {
  it("omits the defaults so the common URL stays short", () => {
    expect(dashboardSearch({ view: "dashboard", branchId: "", from: fallback.from, to: fallback.to, validRange: true }, fallback)).toEqual({});
  });

  it("round-trips a working context through the URL", () => {
    const context = { view: "twin", branchId: "b-2", from: "2026-09-01", to: "2026-09-07", validRange: true } as const;
    const search = dashboardSearch(context, fallback);

    expect(search).toEqual({ view: "twin", branch: "b-2", from: "2026-09-01", to: "2026-09-07" });
    expect(dashboardContext(search, fallback)).toEqual(context);
  });
});

describe("presetRange", () => {
  const today = new Date(2026, 9, 1); // 2026-10-01 local

  it("makes today a single day, not a one-day gap", () => {
    expect(presetRange(1, today)).toEqual({ from: "2026-10-01", to: "2026-10-01" });
  });

  it("spans the stated number of calendar days inclusive", () => {
    expect(presetRange(7, today)).toEqual({ from: "2026-09-25", to: "2026-10-01" });
    expect(presetRange(30, today)).toEqual({ from: "2026-09-02", to: "2026-10-01" });
  });

  it("crosses a month boundary", () => {
    expect(presetRange(7, new Date(2026, 2, 3))).toEqual({ from: "2026-02-25", to: "2026-03-03" });
  });
});
