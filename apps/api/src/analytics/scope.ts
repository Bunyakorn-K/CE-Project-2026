import { canAccessBranch, type AccessGrant } from "../access-policy";

export type ScopeResult =
  | { ok: true; branchId?: string }
  | { ok: false; status: 400 | 403; code: string; message: string };

export function resolveAnalyticsScope(grants: AccessGrant[], requestedBranchId?: string): ScopeResult {
  if (requestedBranchId) {
    return canAccessBranch(grants, requestedBranchId)
      ? { ok: true, branchId: requestedBranchId }
      : { ok: false, status: 403, code: "BRANCH_FORBIDDEN", message: "You cannot view this branch" };
  }
  if (grants.some((grant) => grant.role === "owner")) return { ok: true, branchId: undefined };

  const grantedBranches = [...new Set(grants.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])))];
  return grantedBranches.length === 1
    ? { ok: true, branchId: grantedBranches[0] }
    : { ok: false, status: 400, code: "BRANCH_REQUIRED", message: "Choose a branch before loading analytics" };
}

export type AnalyticsRange = { from: string; to: string };

export type RangeResult =
  | { ok: true; value: AnalyticsRange }
  | { ok: false; status: 400; code: string; message: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function parseAnalyticsRange(from: string | undefined, to: string | undefined, now: Date): RangeResult {
  if (Boolean(from) !== Boolean(to)) {
    return { ok: false, status: 400, code: "INVALID_RANGE", message: "from and to must be supplied together" };
  }
  if (!from || !to) {
    return { ok: true, value: { from: toIsoDate(new Date(now.getTime() - 30 * DAY_MS)), to: toIsoDate(now) } };
  }
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return { ok: false, status: 400, code: "INVALID_RANGE", message: "from and to must be YYYY-MM-DD dates" };
  }
  if (Date.parse(from) > Date.parse(to)) {
    return { ok: false, status: 400, code: "INVALID_RANGE", message: "from must be before to" };
  }
  if (Date.parse(to) - Date.parse(from) > 90 * DAY_MS) {
    return { ok: false, status: 400, code: "RANGE_TOO_LONG", message: "Analytics range is capped at 90 days" };
  }
  return { ok: true, value: { from, to } };
}
