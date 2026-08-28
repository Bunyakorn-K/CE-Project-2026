import { findLiffUser, resolveUserPrincipal, type Principal } from "../access-store";

// The bot derives the MCP accessScope from server-resolved grants: a LINE user
// can never request a branch they are not granted, and revenue visibility is
// derived from role (owner/manager) — never from the user's own claim.

export type AccessScope = {
  branchIds: string[];
  canViewRevenue: boolean;
};

export type IdentityResolution =
  | { ok: true; principal: Principal; scope: AccessScope }
  | { ok: false; code: "unknown_user" | "no_grants" };

export function resolveLineIdentity(lineUserId: string): IdentityResolution {
  const user = findLiffUser(lineUserId);
  if (!user) return { ok: false, code: "unknown_user" };
  const principal = resolveUserPrincipal(user, "liff");
  if (principal.grants.length === 0) return { ok: false, code: "no_grants" };
  return { ok: true, principal, scope: scopeForPrincipal(principal) };
}

export function scopeForPrincipal(principal: Principal): AccessScope {
  const branchIds = principal.grants.some((grant) => grant.role === "owner")
    ? ["*"]
    : [...new Set(principal.grants.flatMap((grant) => (grant.branchId ? [grant.branchId] : [])))];
  const canViewRevenue = principal.grants.some(
    (grant) => grant.role === "owner" || grant.role === "manager"
  );
  return { branchIds, canViewRevenue };
}

export function roleLabel(principal: Principal): string {
  return [...new Set(principal.grants.map((grant) => grant.role))].join(", ");
}
