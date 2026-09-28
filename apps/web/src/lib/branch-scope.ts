export type BranchScopeState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; count: number };

export type BranchScopeView = {
  value: string;
  tone: "success" | "warning" | "danger" | "neutral";
  status: string;
};

/** The react-query fields the card depends on. `branchCount` stays `undefined`
 *  until a grant-derived branch list has actually arrived. */
export type BranchScopeQuery = {
  isError: boolean;
  isLoading: boolean;
  branchCount: number | undefined;
};

export function branchScopeState(query: BranchScopeQuery): BranchScopeState {
  if (query.isError) return { status: "error" };
  if (query.branchCount !== undefined) return { status: "loaded", count: query.branchCount };
  if (query.isLoading) return { status: "loading" };
  // A query that is neither in flight, nor failed, nor holding data never ran
  // (`enabled: false`). It has no grant-derived scope to report, and falling
  // back to "loading" there is the permanent-loading defect this exists to
  // prevent, so it is surfaced as a failure instead.
  return { status: "error" };
}

export function branchScopeView(state: BranchScopeState): BranchScopeView {
  if (state.status === "error") {
    return { value: "โหลดไม่สำเร็จ", tone: "danger", status: "ไม่ทราบขอบเขต" };
  }
  if (state.status === "loading") {
    return { value: "กำลังโหลด", tone: "neutral", status: "ขอบเขตจาก grant" };
  }
  return state.count > 0
    ? { value: String(state.count), tone: "neutral", status: "ขอบเขตจาก grant" }
    : { value: "ไม่มีสาขา", tone: "neutral", status: "ขอบเขตจาก grant" };
}
