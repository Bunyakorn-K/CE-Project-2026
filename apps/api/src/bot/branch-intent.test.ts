import { describe, expect, it } from "vitest";
import { ALL_BRANCHES, branchScopeReplies, isOverviewQuestion, mentionsBranch, shouldAskWhichBranch } from "./branch-intent";

const BRANCHES = [
  { branchId: "b1", branchName: "about you.wash & dry แม่โจ้ - หลิ่งมื่น" },
  { branchId: "b2", branchName: "about you.wash & dry แม่โจ้ - ตลาดโขนเหลือง" }
];

describe("isOverviewQuestion", () => {
  it("recognises the questions that mean 'how is business'", () => {
    expect(isOverviewQuestion("ภาพรวมวันนี้เป็นยังไง")).toBe(true);
    expect(isOverviewQuestion("รายได้เมื่อวานเท่าไหร่")).toBe(true);
    expect(isOverviewQuestion("สรุปให้หน่อย")).toBe(true);
  });

  it("leaves a question that already has a subject alone", () => {
    expect(isOverviewQuestion("เครื่องไหนมีปัญหาบ้าง")).toBe(false);
    expect(isOverviewQuestion("แจ้งเตือนที่ยังไม่รับทราบมีอะไรบ้าง")).toBe(false);
    expect(isOverviewQuestion("อุณหภูมิน้ำวันนี้เท่าไหร่")).toBe(false);
  });

  it("says no to an empty message", () => {
    expect(isOverviewQuestion("   ")).toBe(false);
  });
});

describe("mentionsBranch", () => {
  it("matches the distinguishing tail, which is what people type", () => {
    expect(mentionsBranch("รายได้ของหลิ่งมื่นเมื่อวาน", BRANCHES)).toBe(true);
    expect(mentionsBranch("ภาพรวมตลาดโขนเหลือง", BRANCHES)).toBe(true);
  });

  it("does not match the brand the names share", () => {
    expect(mentionsBranch("ภาพรวม about you.wash & dry", BRANCHES)).toBe(false);
  });
});

describe("shouldAskWhichBranch", () => {
  it("asks when an overview question meets two branches and no memory", () => {
    expect(shouldAskWhichBranch({ text: "ภาพรวมวันนี้เป็นยังไง", branches: BRANCHES, hasRememberedBranch: false })).toBe(true);
  });

  it("does not ask when the person already chose one", () => {
    expect(shouldAskWhichBranch({ text: "ภาพรวมวันนี้เป็นยังไง", branches: BRANCHES, hasRememberedBranch: true })).toBe(false);
  });

  it("does not ask when there is only one branch to mean", () => {
    expect(shouldAskWhichBranch({ text: "ภาพรวมวันนี้เป็นยังไง", branches: [BRANCHES[0]], hasRememberedBranch: false })).toBe(false);
  });

  it("does not ask when the question names the branch", () => {
    expect(shouldAskWhichBranch({ text: "ภาพรวมหลิ่งมื่นวันนี้", branches: BRANCHES, hasRememberedBranch: false })).toBe(false);
  });

  it("does not ask about machines or alerts", () => {
    expect(shouldAskWhichBranch({ text: "เครื่องไหนมีปัญหาบ้าง", branches: BRANCHES, hasRememberedBranch: false })).toBe(false);
  });
});

describe("branchScopeReplies", () => {
  it("offers every branch and the all-branches scope", () => {
    const replies = branchScopeReplies(BRANCHES);
    // Short labels, because LINE cuts at 20 characters and both names share a prefix.
    expect(replies.map((reply) => reply.label)).toEqual(["หลิ่งมื่น", "ตลาดโขนเหลือง", "ทุกสาขา"]);
    expect(replies.at(-1)?.data).toBe(`pref:branch:${ALL_BRANCHES}`);
    // The value is still the real branch id: only the label was shortened.
    expect(replies.map((reply) => reply.data)).toEqual([
      `pref:branch:${BRANCHES[0].branchId}`,
      `pref:branch:${BRANCHES[1].branchId}`,
      `pref:branch:${ALL_BRANCHES}`
    ]);
  });

  it("never hands LINE two labels it would render the same", () => {
    // The production defect: both buttons read "about you.wash & dry".
    const replies = branchScopeReplies(BRANCHES);
    const labels = replies.map((reply) => reply.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.length <= 20)).toBe(true);
  });
});
