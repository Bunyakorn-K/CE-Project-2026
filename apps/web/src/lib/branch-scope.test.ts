import { describe, expect, it } from "vitest";
import { branchScopeState, branchScopeView, type BranchScopeState } from "./branch-scope";

/** A query that never fired: `enabled: false` leaves it pending but not
 *  fetching, so `isLoading` is false and there is no data and no error. */
const IDLE = { isError: false, isLoading: false, branchCount: undefined };

describe("branchScopeState", () => {
  it("reports loading only while the request is still in flight", () => {
    expect(branchScopeState({ isError: false, isLoading: true, branchCount: undefined })).toEqual({ status: "loading" });
  });

  it("never reports loading after a failure", () => {
    expect(branchScopeState({ isError: true, isLoading: false, branchCount: undefined })).toEqual({ status: "error" });
  });

  it("does not report loading for a disabled query that never fires", () => {
    const state = branchScopeState(IDLE);
    expect(state).toEqual({ status: "error" });
    expect(branchScopeView(state).value).not.toBe("กำลังโหลด");
  });

  it("prefers already-loaded data over a still-in-flight refetch", () => {
    expect(branchScopeState({ isError: false, isLoading: true, branchCount: 2 })).toEqual({ status: "loaded", count: 2 });
  });

  it("treats a loaded empty list as loaded, not as a pending request", () => {
    expect(branchScopeState({ isError: false, isLoading: false, branchCount: 0 })).toEqual({ status: "loaded", count: 0 });
  });
});

describe("branchScopeView", () => {
  it("renders the in-flight state", () => {
    expect(branchScopeView({ status: "loading" })).toEqual({ value: "กำลังโหลด", tone: "neutral", status: "ขอบเขตจาก grant" });
  });

  it("renders a failure with the danger tone its neighbours use for failures", () => {
    expect(branchScopeView({ status: "error" })).toEqual({ value: "โหลดไม่สำเร็จ", tone: "danger", status: "ไม่ทราบขอบเขต" });
  });

  it("shows the granted branch count when branches are loaded", () => {
    expect(branchScopeView({ status: "loaded", count: 3 })).toEqual({ value: "3", tone: "neutral", status: "ขอบเขตจาก grant" });
  });

  it("distinguishes an empty grant scope from a pending request", () => {
    const states: BranchScopeState[] = [
      { status: "loading" },
      { status: "error" },
      { status: "loaded", count: 3 },
      { status: "loaded", count: 0 }
    ];
    const views = states.map(branchScopeView);
    expect(new Set(views.map((view) => view.value)).size).toBe(4);
    expect(views[3].value).toBe("ไม่มีสาขา");
  });

  it("claims a grant-derived scope only for states that actually loaded", () => {
    const captionFor = (state: BranchScopeState) => branchScopeView(state).status;
    expect(captionFor({ status: "error" })).not.toBe("ขอบเขตจาก grant");
    expect(captionFor({ status: "loaded", count: 3 })).toBe("ขอบเขตจาก grant");
    expect(captionFor({ status: "loaded", count: 0 })).toBe("ขอบเขตจาก grant");
  });
});
