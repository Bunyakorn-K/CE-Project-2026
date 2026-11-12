import { describe, expect, it } from "vitest";
import { narrowScopeToBranch } from "./scope";

const BRANCHES = [
  { branchId: "b1", branchName: "about you.wash & dry แม่โจ้ - หลิ่งมื่น" },
  { branchId: "b2", branchName: "about you.wash & dry แม่โจ้ - ตลาดโซนเหลือง" }
];
const WIDE = { branchIds: ["*"], canViewRevenue: true };

describe("narrowScopeToBranch", () => {
  it("runs the tools on the remembered branch alone", () => {
    const scope = narrowScopeToBranch({ scope: WIDE, rememberedBranchId: "b1", branches: BRANCHES, question: "ภาพรวมวันนี้เป็นยังไง" });
    expect(scope).toEqual({ branchIds: ["b1"], canViewRevenue: true });
  });

  it("leaves the scope alone when nothing is remembered", () => {
    expect(narrowScopeToBranch({ scope: WIDE, rememberedBranchId: null, branches: BRANCHES, question: "ภาพรวมวันนี้" })).toBe(WIDE);
  });

  it("does not narrow to a branch the person can no longer see", () => {
    // `branches` is what the scope actually resolves to — b1 is not in it.
    const scoped = { branchIds: ["b2"], canViewRevenue: false };
    const visibleToThem = [BRANCHES[1]];
    expect(narrowScopeToBranch({ scope: scoped, rememberedBranchId: "b1", branches: visibleToThem, question: "ภาพรวม" })).toBe(scoped);
  });

  it("lifts the narrowing when the question names another branch", () => {
    const scope = narrowScopeToBranch({ scope: WIDE, rememberedBranchId: "b1", branches: BRANCHES, question: "แล้วตลาดโซนเหลืองล่ะ" });
    expect(scope).toBe(WIDE);
  });

  it("keeps the narrowing when the question names the remembered branch itself", () => {
    const scope = narrowScopeToBranch({ scope: WIDE, rememberedBranchId: "b1", branches: BRANCHES, question: "หลิ่งมื่นวันนี้เป็นไง" });
    expect(scope.branchIds).toEqual(["b1"]);
  });
});
