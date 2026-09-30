import { describe, expect, it } from "vitest";
import { machineStatusMeta, freshnessMeta } from "./machine-status";

describe("machineStatusMeta", () => {
  it("keeps a finished session visually distinct from a paid one", () => {
    const finished = machineStatusMeta("finished");
    const paid = machineStatusMeta("paid");

    expect(finished.label).toBe("จบรอบแล้ว");
    expect(paid.label).toBe("ชำระแล้ว");
    expect(finished.label).not.toBe(paid.label);
  });

  // cancelled (Enum8=5) and admitted (Enum8=6) are documented members of
  // fact_machine_usage.status. They used to fall through to "ไม่ทราบสถานะ".
  it("gives the known cancelled and admitted enums their own Thai labels", () => {
    expect(machineStatusMeta("cancelled").label).toBe("ยกเลิกแล้ว");
    expect(machineStatusMeta("admitted").label).toBe("เริ่มรอบแล้ว");
  });

  it("never renders a raw English enum word for a known status", () => {
    const known = ["running", "washing", "drying", "paid", "finished", "pending", "pending_payment", "cancelled", "admitted", "idle", "ready", "offline", "unknown"];

    for (const status of known) {
      expect(machineStatusMeta(status).label).not.toBe(status);
      expect(machineStatusMeta(status).label).toMatch(/[฀-๿]/);
    }
  });

  it("keeps every status paired with an explicit tone, as DESIGN.md requires", () => {
    const tones = new Set(["status-pill--success", "status-pill--warning", "status-pill--danger", "status-pill--neutral"]);

    for (const status of ["running", "paid", "finished", "cancelled", "admitted", "idle", "offline", "unknown", null, ""]) {
      expect(tones.has(machineStatusMeta(status).className)).toBe(true);
    }
  });

  it("reports an absent or unrecognized value as unknown rather than inventing one", () => {
    expect(machineStatusMeta(null).label).toBe("ไม่ทราบสถานะ");
    expect(machineStatusMeta("").label).toBe("ไม่ทราบสถานะ");
  });

  it("surfaces an unrecognized enum verbatim so data quality stays visible", () => {
    expect(machineStatusMeta("quantum_mode").label).toBe("quantum_mode");
  });

  it("maps running, washing and drying onto the same in-use tone", () => {
    const running = machineStatusMeta("running");
    expect(machineStatusMeta("washing").className).toBe(running.className);
    expect(machineStatusMeta("drying").className).toBe(running.className);
    expect(running.label).toBe("กำลังใช้งาน");
  });
});

describe("freshnessMeta", () => {
  // The Digital Twin renders the server's freshness reason verbatim next to this
  // label. That reason is English ("No recent usage evidence is available for
  // this machine") on a Thai-first page, so the reason has to be derived from
  // the enum here rather than taken from the payload.
  it("gives every known freshness state a Thai reason, not the server's English", () => {
    for (const freshness of ["fresh", "stale", "unavailable"]) {
      const meta = freshnessMeta(freshness);
      expect(meta.known).toBe(true);
      expect(meta.reason).toMatch(/[฀-๿]/);
      expect(meta.reason).not.toMatch(/[A-Za-z]{4,}/);
    }
  });

  it("distinguishes stale from unavailable rather than collapsing both to one message", () => {
    expect(freshnessMeta("stale").reason).not.toBe(freshnessMeta("unavailable").reason);
  });

  it("marks an unrecognized freshness unknown so the caller uses the server's own reason", () => {
    const meta = freshnessMeta("quantum_freshness");
    expect(meta.known).toBe(false);
    // Surfaced verbatim for data quality, matching machineStatusMeta's rule.
    expect(meta.label).toContain("quantum_freshness");
    expect(meta.reason).toBe("");
  });

  it("treats an absent freshness as unknown rather than assuming unavailable", () => {
    expect(freshnessMeta(null).known).toBe(false);
    expect(freshnessMeta("").known).toBe(false);
  });
});
