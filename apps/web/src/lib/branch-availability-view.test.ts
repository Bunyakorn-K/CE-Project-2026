import { describe, expect, it } from "vitest";
import { freshnessMeta } from "./machine-status";
import { explainsClosed, machineAvailability } from "./branch-availability-view";

/**
 * The closed-branch feature exists because production showed19 machines in red
 * `ไม่พร้อมใช้งาน` for a branch that was simply shut (newest usage row 52
 * minutes old, measured 2026-10-01).
 *
 * The guards below were each verified to fail against deliberately broken code:
 * treating `unknown` as `closed` fails the second test, and collapsing the
 * function to `return "closed"` fails the third.
 */

describe("machineAvailability", () => {
  it("shows closed when the API says the branch is shut", () => {
    expect(machineAvailability("unavailable", "closed")).toBe("closed");
  });

  it("never softens the alarm on an unknown branch state", () => {
    // SAFETY GUARD. Breaks if `unknown` is treated as `closed`.
    expect(machineAvailability("unavailable", "unknown")).toBe("unavailable");
    expect(machineAvailability("unavailable", null)).toBe("unavailable");
    expect(machineAvailability("unavailable", undefined)).toBe("unavailable");
  });

  it("keeps a real fault visible while the branch is open", () => {
    // SAFETY GUARD. Breaks if the function collapses to `return "closed"`.
    expect(machineAvailability("unavailable", "open")).toBe("unavailable");
  });

  it("treats an unrecognised branch state as unknown, not closed", () => {
    expect(machineAvailability("unavailable", "shut")).toBe("unavailable");
    expect(machineAvailability("unavailable", "CLOSED")).toBe("unavailable");
  });

  it.each(["fresh", "stale", "unavailable"] as const)(
    "passes %s through when the branch is open",
    (freshness) => {
      expect(machineAvailability(freshness, "open")).toBe(freshness);
    }
  );

  it("renders an absent freshness as unavailable, not fresh", () => {
    // An older payload carries no freshness at all. Defaulting to `fresh`
    // would assert currency the payload never claimed.
    expect(machineAvailability(null, "open")).toBe("unavailable");
    expect(machineAvailability("something-new", "open")).toBe("unavailable");
  });

  it("degrades to today's rendering when the API predates the feature", () => {
    // The pre-feature API sends no branch state. Every value must render
    // exactly as it did before, which is what keeps an older server safe.
    for (const freshness of ["fresh", "stale", "unavailable"] as const) {
      expect(machineAvailability(freshness, undefined)).toBe(freshness);
    }
  });
});

describe("the closed label", () => {
  it("is neutral, never danger", () => {
    // A shut branch must raise no alarm. If this ever reads --danger the
    // 19-red-cards symptom is back.
    expect(freshnessMeta("closed").className).toBe("status-pill--neutral");
  });

  it("says the branch is closed rather than that the machine is unavailable", () => {
    expect(freshnessMeta("closed").label).toBe("ปิดตามเวลาทำการ");
    expect(freshnessMeta("closed").label).not.toBe(freshnessMeta("unavailable").label);
  });

  it("carries a Thai reason a reader can act on", () => {
    expect(freshnessMeta("closed").known).toBe(true);
    expect(freshnessMeta("closed").reason).toBe(
      "สาขาปิดตามเวลาทำการ จึงไม่มีข้อมูลการใช้งานของเครื่องนี้"
    );
  });

  it("leaves unavailable red, because an open branch with no data is a fault", () => {
    expect(freshnessMeta("unavailable").className).toBe("status-pill--danger");
  });

  it("renders an unrecognised freshness as unknown, never as closed", () => {
    // Both are neutral, so the class is not what separates them — the label is.
    // Asserting the class here would pass for the wrong reason and would not
    // catch a build that coloured unknown red.
    expect(freshnessMeta("shut").label).toContain("ความสดไม่ทราบ");
    expect(freshnessMeta("shut").label).not.toBe(freshnessMeta("closed").label);
    expect(freshnessMeta("shut").className).toBe("status-pill--neutral");
  });
});

describe("explainsClosed", () => {
  it("is true only for a positively reported closed branch", () => {
    expect(explainsClosed("closed")).toBe(true);
    expect(explainsClosed("open")).toBe(false);
    expect(explainsClosed("unknown")).toBe(false);
    expect(explainsClosed(undefined)).toBe(false);
  });
});