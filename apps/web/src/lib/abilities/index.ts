import { useMemo } from "react";
import { useAtom } from "jotai";
import { AbilityBuilder, createMongoAbility, type MongoAbility } from "@casl/ability";
import { authAtom, type AuthUser } from "../atoms/auth";

type AppAction = "read" | "manage" | "update" | "create" | "delete";
type AppSubject =
  | "Analytics"
  | "Machines"
  | "Revenue"
  | "BackofficeAdmin"
  | "AiAdmin"
  | `Branch:${string}`;

export type AppAbility = MongoAbility<[AppAction, AppSubject]>;

export function defineAbilityFor(user: AuthUser | null): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  const grants = user?.grants ?? [];
  const isOwner = grants.some((g) => g.role === "owner");
  const isManager = grants.some((g) => g.role === "manager");

  if (isOwner) {
    can("manage", ["BackofficeAdmin", "AiAdmin"]);
    can("manage", ["Analytics", "Machines", "Revenue"]);
    for (const g of grants) {
      if (g.branchId) can("manage", `Branch:${g.branchId}`);
    }
  } else if (isManager) {
    can("read", "Analytics");
    can("manage", "Revenue");
    can("read", "Machines");
    for (const g of grants) {
      if (g.branchId) can("read", `Branch:${g.branchId}`);
    }
  } else {
    can("read", "Machines");
    for (const g of grants) {
      if (g.branchId) can("read", `Branch:${g.branchId}`);
    }
  }

  return build();
}

export function useAbility(): AppAbility {
  const [user] = useAtom(authAtom);
  return useMemo(() => defineAbilityFor(user), [user]);
}