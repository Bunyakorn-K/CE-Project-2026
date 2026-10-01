export type Role = "owner" | "manager" | "technician";

/**
 * What the direct-grant form sends, and whether it may send it at all.
 *
 * The rule that matters is the same one the API enforces in
 * `validateGrantScope`: `owner` is tenant-wide and takes no branch, while
 * `manager` and `technician` each need exactly one. Encoding it here means the
 * button's disabled state and the request body cannot disagree — a form that
 * sends `branchId: "…"` with `role: "owner"` is rejected by the server, and a
 * form that silently drops the branch would grant tenant-wide access to someone
 * meant to have one branch. That second failure is the dangerous one, because
 * it widens access rather than erroring.
 *
 * Extracted as a pure function because the form itself can only be exercised as
 * a signed-in owner against a running API, which is exactly the situation in
 * which a defect reaches production unobserved.
 */
export function buildGrantRequest(input: {
  email: string;
  role: Role;
  branchId: string;
}): { ok: true; body: { email: string; role: Role; branchId: string | null } } | { ok: false; reason: "email-required" | "branch-required" } {
  const email = input.email.trim();
  if (!email) return { ok: false, reason: "email-required" };

  // An owner grant is tenant-wide. Sending a branch with it is refused by the
  // API, so the branch is dropped here rather than carried into a request that
  // can only fail.
  if (input.role === "owner") return { ok: true, body: { email, role: "owner", branchId: null } };

  if (!input.branchId) return { ok: false, reason: "branch-required" };
  return { ok: true, body: { email, role: input.role, branchId: input.branchId } };
}

/** Whether the submit button is enabled, kept in step with the payload builder. */
export function canSubmitGrant(input: { email: string; role: Role; branchId: string }): boolean {
  return buildGrantRequest(input).ok;
}
