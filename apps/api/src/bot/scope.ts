// The remembered branch is a scope, not a hint.
//
// A preference used to reach the model only as a line of prompt text
// ("สาขาประจำ: …"). The tools were still called with the person's full scope, so
// the model asked the warehouse for every branch and answered "ทุกสาขา" — the
// preference changed the wording of the prompt and nothing about the data.
//
// The tools are the thing that must narrow. This returns the scope to run them
// with: the remembered branch alone, unless the person can no longer see it or
// has just asked about a different branch in their own words.

import type { AccessScope } from "./identity";
import { mentionsBranch, type BranchRef } from "./branch-intent";

export function narrowScopeToBranch(input: {
  scope: AccessScope;
  rememberedBranchId: string | null;
  branches: BranchRef[];
  question: string;
}): AccessScope {
  const { scope, rememberedBranchId, branches, question } = input;
  if (!rememberedBranchId) return scope;

  // A preference outlives a grant. If the branch is gone from their scope, the
  // scope wins — a stale id must not be turned into a query for data they lost.
  const stillVisible = branches.some((branch) => branch.branchId === rememberedBranchId);
  if (!stillVisible) return scope;

  // "แล้วสาขาอีกอันล่ะ" is a deliberate move; narrowing would answer a question
  // they did not ask. Only a named other branch lifts the narrowing.
  const others = branches.filter((branch) => branch.branchId !== rememberedBranchId);
  if (mentionsBranch(question, others)) return scope;

  return { ...scope, branchIds: [rememberedBranchId] };
}
