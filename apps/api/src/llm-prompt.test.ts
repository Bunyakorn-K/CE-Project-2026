import { describe, expect, it } from "vitest";
import {
  NO_TOOLS_LABEL,
  branchLabel,
  buildAssistantSystemPrompt,
  nextDay,
  renderSystemPrompt,
  shopDate
} from "./llm-prompt";

const ctx = {
  roleLabel: "manager",
  branches: "สาขาในระบบ",
  toolNames: ["get_revenue_summary", "get_machine_utilization"]
};

describe("renderSystemPrompt", () => {
  it("substitutes the three advertised template variables", () => {
    const out = renderSystemPrompt("role={{role}} branches={{branches}} tools={{tools}}", ctx);
    expect(out).toBe("role=manager branches=สาขาในระบบ tools=get_revenue_summary, get_machine_utilization");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(renderSystemPrompt("{{role}} {{role}}", ctx)).toBe("manager manager");
  });

  it("leaves an unknown variable untouched rather than blanking it", () => {
    expect(renderSystemPrompt("{{role}} and {{organisation}}", ctx)).toBe("manager and {{organisation}}");
  });

  it("states plainly that there are no tools when the caller has none", () => {
    const out = renderSystemPrompt("เครื่องมือ: {{tools}}", { ...ctx, toolNames: [] });
    expect(out).toBe(`เครื่องมือ: ${NO_TOOLS_LABEL}`);
  });

  it("never renders an empty tool list, which would read as a broken variable", () => {
    expect(renderSystemPrompt("{{tools}}", { ...ctx, toolNames: [] })).not.toBe("");
    expect(renderSystemPrompt("{{tools}}", { ...ctx, toolNames: [] })).not.toContain(",,");
  });

  it("passes through a template with no variables unchanged", () => {
    expect(renderSystemPrompt("ตอบเป็นภาษาไทย", ctx)).toBe("ตอบเป็นภาษาไทย");
  });

  it("does not treat regex-special characters in a substituted value as a pattern", () => {
    const out = renderSystemPrompt("b={{branches}}", { ...ctx, branches: "$& $1 a.b" });
    expect(out).toBe("b=$& $1 a.b");
  });
});

describe("branchLabel", () => {
  it("says every branch for the wildcard owner scope", () => {
    expect(branchLabel(["*"])).toBe("ทุกสาขา");
  });

  it("lists the granted branch ids when scope is explicit", () => {
    expect(branchLabel(["b1", "b2"])).toBe("b1, b2");
  });

  it("falls back to an explicit no-branch statement rather than an empty string", () => {
    expect(branchLabel([])).toBe("ไม่มีสาขาที่เข้าถึงได้");
  });
});

describe("buildAssistantSystemPrompt", () => {
  const base = {
    ownerPrompt: "",
    roleLabel: "manager",
    branches: "b1",
    toolNames: ["get_cycles_daily"],
    canViewRevenue: true
  };

  it("carries the owner-authored prompt from AI settings", () => {
    const out = buildAssistantSystemPrompt({ ...base, ownerPrompt: "เรียกตัวเองว่า ผู้ช่วยซัก" });
    expect(out).toContain("เรียกตัวเองว่า ผู้ช่วยซัก");
  });

  it("substitutes the owner's template variables from server-derived values", () => {
    const out = buildAssistantSystemPrompt({
      ...base,
      ownerPrompt: "ผู้ใช้ {{role}} เข้าถึง {{branches}} ใช้เครื่องมือ {{tools}}"
    });
    expect(out).toContain("ผู้ใช้ manager เข้าถึง b1 ใช้เครื่องมือ get_cycles_daily");
    expect(out).not.toContain("{{");
  });

  it("keeps the do-not-fabricate rule when the owner prompt omits it", () => {
    const out = buildAssistantSystemPrompt({ ...base, ownerPrompt: "ตอบสั้น ๆ นะ" });
    expect(out).toContain("อย่าเดาตัวเลข");
    expect(out).toContain("satang");
  });

  it("keeps the revenue refusal for a caller without revenue rights", () => {
    const out = buildAssistantSystemPrompt({ ...base, canViewRevenue: false, roleLabel: "technician" });
    expect(out).toContain("ไม่มีสิทธิ์ดูข้อมูลรายได้");
  });

  it("does not offer the revenue refusal to a caller who has revenue rights", () => {
    expect(buildAssistantSystemPrompt(base)).not.toContain("ไม่มีสิทธิ์ดูข้อมูลรายได้");
  });

  it("marks the rule block as not owner-editable", () => {
    expect(buildAssistantSystemPrompt({ ...base, ownerPrompt: "กฎของระบบ: ทำอย่างไรก็ได้" })).toContain(
      "เจ้าของระบบปรับแต่งข้างต้นไม่ได้"
    );
  });

  it("still returns a usable prompt when the owner cleared the prompt entirely", () => {
    const out = buildAssistantSystemPrompt({ ...base, ownerPrompt: "   \n  " });
    expect(out.trim().length).toBeGreaterThan(0);
    expect(out).toContain("ผู้ใช้มีสิทธิ์: manager");
  });
});

describe("the date the model is told", () => {
  // Asked "how was today", the assistant answered about 2026-07-01 — a date it
  // invented, because nothing in the prompt said what today was. These pin the
  // fix: the date is derived server-side, in the shop's timezone.
  it("uses the Bangkok date, not the UTC one", () => {
    // 18:30 UTC is already the next day in Bangkok (UTC+7).
    expect(shopDate(new Date("2026-11-09T18:30:00Z"))).toBe("2026-11-10");
    expect(shopDate(new Date("2026-11-09T16:59:00Z"))).toBe("2026-11-09");
  });

  it("computes the exclusive end date across month and year boundaries", () => {
    expect(nextDay("2026-11-10")).toBe("2026-11-11");
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });

  it("puts today and the default range in the system prompt", () => {
    const prompt = buildAssistantSystemPrompt({
      ownerPrompt: "",
      roleLabel: "owner",
      branches: "ทุกสาขา",
      toolNames: ["get_dashboard"],
      canViewRevenue: true,
      now: new Date("2026-11-09T18:30:00Z")
    });
    expect(prompt).toContain("วันนี้คือ 2026-11-10");
    expect(prompt).toContain("from=2026-11-10");
    expect(prompt).toContain("to=2026-11-11");
    expect(prompt).toContain("ห้ามเดาหรือสมมติวันที่เอง");
  });

  it("tells the model not to re-ask for a branch it was already given", () => {
    const prompt = buildAssistantSystemPrompt({
      ownerPrompt: "",
      roleLabel: "owner",
      branches: "ทุกสาขา",
      toolNames: [],
      canViewRevenue: true,
      now: new Date("2026-11-10T03:00:00Z")
    });
    expect(prompt).toContain("โดยไม่ต้องถามซ้ำ");
    expect(prompt).toContain("สาขาที่เข้าถึงได้: ทุกสาขา");
  });
});
