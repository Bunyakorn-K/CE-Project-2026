// Seed the AI gateway (Bifrost) settings from environment variables.
// Used at deploy time on the VM; also works locally.
//
//   AI_BASE_URL   (default https://llm.kovaspire.com)
//   AI_MODEL      (default KiosAPI/deepseek-v4-flash)
//   AI_API_KEY    (required — from the deploy secret file)
//   ACTOR_USER_ID (default: first owner grant's user id in the DB)
//
// Run from apps/api:  pnpm exec tsx scripts/seed-ai-settings.ts
import { eq } from "drizzle-orm";
import { updateAiSettings, getAiSettingsWithKey } from "../src/ai-settings";

const baseUrl = process.env.AI_BASE_URL ?? "https://llm.kovaspire.com";
const model = process.env.AI_MODEL ?? "KiosAPI/deepseek-v4-flash";
const apiKey = process.env.AI_API_KEY;

if (!apiKey) {
  console.error("AI_API_KEY is required");
  process.exit(1);
}

// Resolve the actor: env override, else the first owner grant in the DB.
let actorUserId = process.env.ACTOR_USER_ID;
if (!actorUserId) {
  const { db } = await import("../src/db");
  const { accessGrant } = await import("../src/schema");
  const row = db
    .select({ userId: accessGrant.userId })
    .from(accessGrant)
    .where(eq(accessGrant.role, "owner"))
    .limit(1)
    .get();
  if (!row) {
    console.error("No owner user found in DB; set ACTOR_USER_ID");
    process.exit(1);
  }
  actorUserId = row.userId;
}

const saved = updateAiSettings({ baseUrl, model, apiKey }, actorUserId);
const check = getAiSettingsWithKey();
console.log(
  JSON.stringify(
    {
      saved: { baseUrl: saved.baseUrl, model: saved.model, hasApiKey: saved.hasApiKey, updatedAt: saved.updatedAt },
      decryptOk: check.apiKey === apiKey
    },
    null,
    2
  )
);
