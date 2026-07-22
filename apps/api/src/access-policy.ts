export type Role = "owner" | "manager" | "technician";

export type AccessGrant = {
  id: string;
  role: Role;
  branchId: string | null;
};

export function canAccessBranch(grants: AccessGrant[], branchId: string) {
  return grants.some((grant) => grant.role === "owner" || grant.branchId === branchId);
}

export function mayViewRevenue(grants: AccessGrant[]) {
  return grants.some((grant) => grant.role === "owner" || grant.role === "manager");
}

export function mayManageAccess(grants: AccessGrant[]) {
  return grants.some((grant) => grant.role === "owner");
}
