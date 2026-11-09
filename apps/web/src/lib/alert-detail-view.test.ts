import { describe, expect, it } from "vitest";
import {
  deliveryLine,
  detailRows,
  formatBangkok,
  rawEvidenceJson,
  severityMeta,
  type AlertDetail
} from "./alert-detail-view";

const EVIDENCE = {
  channel: "gas_run_b_pressure",
  window: { from: "2026-11-09T07:00:00.600Z", to: "2026-11-09T13:00:00.600Z" },
  sampleCount: 591,
  nonNullCount: 590,
  coveragePct: 99.3,
  nullMinutes: 1,
  spanMinutes: 344,
  firstEdgePsi: 123,
  lastEdgePsi: 110,
  edgeRatePsiPerHour: -2.2674,
  slopePsiPerHour: -2.8174,
  machineState: "running",
  temperatureC: 68.57309385055319,
  temperatureAgeHours: 24,
  branchOpenState: "open",
  thresholdVersion: "2026-11-09.1"
};

function alert(over: Partial<AlertDetail> = {}): AlertDetail {
  return {
    id: "gas:gas_run_b_pressure:declining:2026-11-09T14",
    branchId: "5e9611c1-6380-4d58-8ec7-ba4fb8fe4369",
    machineId: null,
    severity: "warning",
    title: "แนวโน้มแรงดันแก๊สลดลงต่อเนื่อง",
    message: "🔔 LaundryTwin แจ้งเตือน (WARNING)",
    evidence: EVIDENCE,
    status: "sent",
    attemptedAt: "2026-11-09T14:20:00.848Z",
    deliveredAt: "2026-11-09T14:20:00.848Z",
    error: null,
    ...over
  };
}

describe("detailRows", () => {
  it("puts the two numbers that decided the alert first", () => {
    const rows = detailRows(alert());
    expect(rows[0]).toEqual({ label: "ช่องวัด", value: "gas_run_b_pressure" });
    expect(rows[1]).toEqual({ label: "แรงดัน (หัวช่วง → ท้ายช่วง)", value: "123 → 110 psi" });
    expect(rows[2]).toEqual({ label: "อัตราลดลง (ตัวที่ใช้ตัดสิน)", value: "-2.27 psi/ชม." });
    expect(rows[3]).toEqual({ label: "ความชันเชิงเส้น (อ้างอิง)", value: "-2.82 psi/ชม." });
  });

  it("rounds the temperature and keeps the age of the reading it came from", () => {
    const rows = detailRows(alert());
    const temperature = rows.find((row) => row.label === "อุณหภูมิ");
    expect(temperature?.value).toBe("68.6 °C (อ่านล่าสุด 24 ชม. ก่อน)");
  });

  it("drops the age note when the reading was inside the window", () => {
    const rows = detailRows(alert({ evidence: { ...EVIDENCE, temperatureAgeHours: 0 } }));
    expect(rows.find((row) => row.label === "อุณหภูมิ")?.value).toBe("68.6 °C");
  });

  it("shows — rather than 0 for a value it does not have", () => {
    const rows = detailRows(
      alert({ evidence: { channel: "gas_run_a_pressure", firstEdgePsi: null, lastEdgePsi: 51 } })
    );
    expect(rows.find((row) => row.label === "แรงดัน (หัวช่วง → ท้ายช่วง)")?.value).toBe("— → 51 psi");
    // Nothing invented for a field that is absent altogether.
    expect(rows.some((row) => row.label === "อุณหภูมิ")).toBe(false);
    expect(rows.some((row) => row.label === "อัตราลดลง (ตัวที่ใช้ตัดสิน)")).toBe(false);
  });

  it("renders the window in Bangkok time, which is the clock the shop reads", () => {
    const rows = detailRows(alert());
    expect(rows.find((row) => row.label === "หน้าต่างการวัด")?.value).toBe(
      "09/11/2569 14:00:00 → 09/11/2569 20:00:00"
    );
  });

  it("always ends with the id, so a screenshot can be traced back", () => {
    const rows = detailRows(alert());
    expect(rows[rows.length - 1]).toEqual({
      label: "รหัสการแจ้งเตือน",
      value: "gas:gas_run_b_pressure:declining:2026-11-09T14"
    });
  });
});

describe("deliveryLine", () => {
  it("says sent with the delivery time", () => {
    expect(deliveryLine(alert()).tone).toBe("ok");
    expect(deliveryLine(alert()).text).toContain("ส่งถึง LINE แล้ว");
  });

  it("carries the reason when the send failed", () => {
    const line = deliveryLine(alert({ status: "failed", deliveredAt: null, error: "LINE_CHANNEL_ACCESS_TOKEN is not configured" }));
    expect(line.tone).toBe("failed");
    expect(line.text).toContain("LINE_CHANNEL_ACCESS_TOKEN is not configured");
  });

  it("does not call an in-flight send a failure", () => {
    expect(deliveryLine(alert({ status: "sending", deliveredAt: null })).tone).toBe("pending");
  });
});

describe("severityMeta", () => {
  it("maps the server's severities to Thai labels", () => {
    expect(severityMeta("critical").label).toBe("วิกฤต");
    expect(severityMeta("warning").label).toBe("เตือน");
    expect(severityMeta("info").label).toBe("ข้อมูล");
    expect(severityMeta("warning").tone).toBe("warning");
  });
});

describe("rawEvidenceJson", () => {
  it("prints the whole evidence object so nothing can be hidden by the summary", () => {
    const parsed = JSON.parse(rawEvidenceJson(alert())) as Record<string, unknown>;
    expect(parsed.channel).toBe("gas_run_b_pressure");
    expect(parsed.thresholdVersion).toBe("2026-11-09.1");
    expect(Object.keys(parsed).length).toBeGreaterThan(10);
  });
});

describe("formatBangkok", () => {
  it("is UTC+7 and says so by shifting the clock, not the label", () => {
    expect(formatBangkok("2026-11-09T13:00:00.600Z")).toBe("09/11/2569 20:00:00");
  });

  it("returns the raw string rather than inventing a date", () => {
    expect(formatBangkok("not-a-date")).toBe("not-a-date");
    expect(formatBangkok(null)).toBe("—");
  });
});
