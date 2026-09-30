// The single front-end source of role truth.
//
// This replaces two things that had drifted apart:
//
//   - `lib/abilities/index.ts`, a CASL rule set that nothing imported. It was
//     documented as the front-end guard but no route consulted it, and its
//     rules had quietly diverged from the checks the routes actually ran.
//   - the owner predicate, which had been copy-pasted into four routes.
//
// What this is NOT: a security control. These predicates decide what the
// browser renders; the server independently derives scope from the same grants
// and rejects anything the client asked for that it should not have. Removing
// every call to these functions would leak layout, not data.

export type AccessGrantLike = { role: string; branchId: string | null };

export type AuthUserLike = { grants: ReadonlyArray<AccessGrantLike> } | null;

/** Access administration — grants, sessions, AI settings, and the owner-only tools. */
export function isOwner(user: AuthUserLike): boolean {
  return user?.grants.some((grant) => grant.role === "owner") ?? false;
}

/**
 * Revenue visibility. Matches the server rule in `mayViewRevenue`: owner and
 * manager may see revenue, a technician may not. A null user is denied.
 */
export function canViewRevenue(user: AuthUserLike): boolean {
  return user?.grants.some((grant) => grant.role === "owner" || grant.role === "manager") ?? false;
}
