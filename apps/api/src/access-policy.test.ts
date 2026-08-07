import { describe, expect, it } from "vitest";
import { canAccessBranch, mayManageAccess, mayViewRevenue, type AccessGrant } from "./access-policy";

const branchOne = "b1c470cc-4ca2-4e5f-8af2-d0b5539e13f8";
const branchTwo = "3f01cc02-ed2f-4b86-8949-50eb018025a6";

describe("LaundryTwin access policy", () => {
  it("keeps a technician inside their assigned branch and away from revenue", () => {
    const grants: AccessGrant[] = [{ id: "grant-1", role: "technician", branchId: branchOne }];

    expect(canAccessBranch(grants, branchOne)).toBe(true);
    expect(canAccessBranch(grants, branchTwo)).toBe(false);
    expect(mayViewRevenue(grants)).toBe(false);
  });

  it("lets an owner access every branch and manage local access", () => {
    const grants: AccessGrant[] = [{ id: "grant-2", role: "owner", branchId: null }];

    expect(canAccessBranch(grants, branchTwo)).toBe(true);
    expect(mayViewRevenue(grants)).toBe(true);
    expect(mayManageAccess(grants)).toBe(true);
  });
});
