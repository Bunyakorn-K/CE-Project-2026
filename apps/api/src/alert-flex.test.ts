import { describe, expect, it } from "vitest";
import { ALT_TEXT_LIMIT, alertRows, buildAlertFlex, num, shortTime } from "./alert-flex";
import type { IrisAlert } from "./iris-read-client";

const WINDOW = { from: "2026-11-09T07:00:00.600Z", to: "2026-11-09T13:00:00.600Z" };

/** The evidence the gas rule really produced in production on 2026-11-09. */
function gasAlert(over: Partial<IrisAlert> = {}): IrisAlert {
  return {
    id: "gas:gas_run_a_pressure:declining:2026-11-09T13",
    branchId: "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369",
    machineId: null,
    ruleId: "gas.gas_run_a_pressure.declining",
    ruleUpdatedAt: null,
    ruleVersion: "2026-11-09.1",
    severity: "warning",
    title: "แนวโน้มแรงดันแก๊สลดลงต่อเนื่อง",
    detail: "ช่อง: gas_run_a_pressure · … ไม่ใช่การตรวจจับแก๊สรั่ว",
    tags: [],
    evidence: {
      channel: "gas_run_a_pressure",
      window: WINDOW,
      sampleCount: 193,
      nonNullCount: 190,
      coveragePct: 97.9,
      nullMinutes: 3,
      spanMinutes: 343,
      firstEdgePsi: 68,
      lastEdgePsi: 51,
      edgeRatePsiPerHour: -3.6697,
      slopePsiPerHour: -2.7072,
      machineState: "running",
      temperatureC: 68.57309385055319,
      temperatureAgeHours: 24,
      branchOpenState: "open"
    },
    detectedAt: "2026-11-09T13:00:00.600Z",
    acknowledgedAt: null,
    coverage: {},
    ...over
  };
}

describe("alertRows", () => {
  it("formats every number and says which rate decided the alert", () => {
    const rows = alertRows(gasAlert());
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));

    expect(byLabel["ช่องวัด"]).toBe("gas_run_a_pressure");
    expect(byLabel["แรงดัน"]).toBe("68 psi → 51 psi");
    // The gate, named as the gate; the fitted slope kept beside it as reference.
    expect(byLabel["อัตราลดลง (ใช้ตัดสิน)"]).toBe("-3.67 psi/ชม.");
    expect(byLabel["ความชัน (อ้างอิง)"]).toBe("-2.71 psi/ชม.");
    // 17 significant digits is not a temperature.
    expect(byLabel["อุณหภูมิ"]).toBe("68.6 °C (24 ชม. ก่อน)");
    expect(byLabel["ความครอบคลุม"]).toBe("97.9% · 193 ตัวอย่าง");
    expect(byLabel["ช่วงที่อ่านไม่ได้"]).toBe("3 นาที");
    expect(byLabel["สถานะเครื่อง"]).toBe("running");
  });

  it("never invents a value for evidence that is missing", () => {
    const rows = alertRows(
      gasAlert({
        evidence: {
          channel: "gas_run_b_pressure",
          window: WINDOW,
          sampleCount: 527,
          coveragePct: 99.2,
          machineState: "unknown",
          temperatureC: null,
          branchOpenState: "unknown"
        }
      })
    );
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));

    expect(byLabel["อุณหภูมิ"]).toBeUndefined();
    expect(byLabel["แรงดัน"]).toBeUndefined();
    expect(byLabel["อัตราลดลง (ใช้ตัดสิน)"]).toBeUndefined();
    // What is unknown is shown as unknown rather than dropped or zeroed.
    expect(byLabel["สถานะเครื่อง"]).toBe("unknown");
  });

  it("keeps a plain alert readable without gas evidence", () => {
    const rows = alertRows(
      gasAlert({
        id: "iris:machine-offline:42",
        ruleId: "iris.machine.offline",
        machineId: "machine-7",
        evidence: {}
      })
    );
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
    expect(byLabel["เครื่อง"]).toBe("machine-7");
    expect(byLabel["สาขา"]).toBe("5e9611c1-6380-4d58-8ec7-ba4fb8fe4369");
  });
});

describe("buildAlertFlex", () => {
  it("builds a bubble with a coloured header, a body of rows and a footer", () => {
    const { contents } = buildAlertFlex(gasAlert());
    expect(contents.type).toBe("bubble");
    const header = contents.header as { backgroundColor: string; contents: Array<{ text: string }> };
    expect(header.backgroundColor).toBe("#D9822B"); // warning
    expect(header.contents.some((item) => item.text.includes("WARNING"))).toBe(true);
    const body = contents.body as { contents: unknown[] };
    expect(body.contents.length).toBe(alertRows(gasAlert()).length);
    const footer = contents.footer as { contents: Array<{ text: string }> };
    expect(footer.contents.some((item) => item.text.includes("ไม่ใช่การตรวจจับแก๊สรั่ว"))).toBe(true);
  });

  it("uses the severity to pick the header colour", () => {
    const critical = buildAlertFlex(gasAlert({ severity: "critical" })).contents.header as { backgroundColor: string };
    const info = buildAlertFlex(gasAlert({ severity: "info" })).contents.header as { backgroundColor: string };
    expect(critical.backgroundColor).toBe("#C0392B");
    expect(info.backgroundColor).toBe("#2E6FB7");
  });

  it("keeps altText standalone and inside LINE's 400-character limit", () => {
    const { altText } = buildAlertFlex(gasAlert());
    expect(altText.length).toBeLessThanOrEqual(ALT_TEXT_LIMIT);
    expect(altText).toContain("LaundryTwin");
    expect(altText).toContain("gas_run_a_pressure");
    expect(altText).toContain("-3.67 psi/ชม.");
    // It carries the strong rows only — the reference slope is not a headline.
    expect(altText).not.toContain("อ้างอิง");
  });

  it("truncates rather than sending a payload LINE would reject", () => {
    const longTitle = "ก".repeat(500);
    const { altText } = buildAlertFlex(gasAlert({ title: longTitle }));
    expect(altText.length).toBeLessThanOrEqual(ALT_TEXT_LIMIT);
    expect(altText.endsWith("…")).toBe(true);
  });

  it("produces plain JSON with no undefined fields, which LINE would reject", () => {
    const { contents } = buildAlertFlex(gasAlert());
    const serialised = JSON.stringify(contents);
    expect(serialised).not.toContain("undefined");
    expect(JSON.parse(serialised)).toEqual(contents);
  });
});

describe("helpers", () => {
  it("formats to fixed digits and refuses non-finite input", () => {
    expect(num(68.57309385055319, 1)).toBe("68.6");
    expect(num("97.94", 1)).toBe("97.9");
    expect(num(null, 1)).toBeNull();
    expect(num(Number.NaN, 1)).toBeNull();
    expect(num(undefined, 2)).toBeNull();
  });

  it("renders window bounds in the branch's timezone, not UTC", () => {
    // 13:00Z is 20:00 in Bangkok — the clock the shop reads.
    expect(shortTime("2026-11-09T13:00:00.600Z")).toBe("11-09 20:00");
  });
});
