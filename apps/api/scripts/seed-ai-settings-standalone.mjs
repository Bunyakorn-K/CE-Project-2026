// Standalone Bifrost AI-settings seed — runs inside the production container
// where only better-sqlite3 + dotenv exist (drizzle is bundled into dist).
//
// Replicates the exact encryption from src/ai-settings.ts:
//   key  = sha256(BETTER_AUTH_SECRET)
//   blob = base64( iv(12) | gcmTag(16) | ciphertext )
//
// Env: DATABASE_PATH (default /data/laundrytwin.sqlite), BETTER_AUTH_SECRET,
//      AI_BASE_URL, AI_MODEL, AI_API_KEY, ACTOR_USER_ID (optional)
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";

const dbPath = process.env.DATABASE_PATH ?? "/data/laundrytwin.sqlite";
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const baseUrl = process.env.AI_BASE_URL ?? "https://llm.kovaspire.com";
const model = process.env.AI_MODEL ?? "KiosAPI/deepseek-v4-flash";
const apiKey = process.env.AI_API_KEY;
const secret = process.env.BETTER_AUTH_SECRET;

if (!apiKey || !secret) {
  console.error("AI_API_KEY and BETTER_AUTH_SECRET are required");
  process.exit(1);
}

const key = createHash("sha256").update(secret).digest();
const iv = randomBytes(12);
const cipher = createCipheriv("aes-256-gcm", key, iv);
const enc = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag();
const blob = Buffer.concat([iv, tag, enc]).toString("base64");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Actor: explicit id, else first owner grant in access_grant.
let actor = process.env.ACTOR_USER_ID ?? null;
if (!actor) {
  const row = db.prepare("SELECT user_id FROM access_grant WHERE role = 'owner' AND revoked_at IS NULL LIMIT 1").get();
  if (!row) {
    console.error("No owner grant found; set ACTOR_USER_ID");
    process.exit(1);
  }
  actor = row.user_id;
}

const now = Date.now();
const existing = db.prepare("SELECT id FROM ai_settings WHERE id = 'default'").get();

if (existing) {
  db.prepare(
    `UPDATE ai_settings SET base_url=?, api_key_encrypted=?, model=?, updated_by_user_id=?, updated_at=? WHERE id='default'`
  ).run(baseUrl, blob, model, actor, now);
} else {
  db.prepare(
    `INSERT INTO ai_settings (id, base_url, api_key_encrypted, model, system_prompt, temperature, updated_by_user_id, updated_at, created_at)
     VALUES ('default', ?, ?, ?, 'คุณคือผู้ช่วยข้อมูลของระบบ LaundryTwin', 70, ?, ?, ?)`
  ).run(baseUrl, blob, model, actor, now, now);
}

const check = db.prepare("SELECT api_key_encrypted FROM ai_settings WHERE id = 'default'").get();
console.log(JSON.stringify({ baseUrl, model, actor, rowCount: check ? 1 : 0, wrote: true }, null, 2));
