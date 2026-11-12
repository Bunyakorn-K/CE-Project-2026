// AI console settings (backoffice). Stores the OpenAI-compatible gateway
// config LaundryTwin uses to talk to an LLM (default: Bifrost). The API key
// is encrypted at rest with BETTER_AUTH_SECRET (AES-256-GCM) and never
// returned to the browser — only a hasApiKey boolean mask is.
//
// Security invariants:
//   - key material derives from BETTER_AUTH_SECRET (already required in prod)
//   - the browser receives baseUrl/model/prompt but never the api key
//   - changes are audit-logged via the existing audit_log table

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { resolveServerSecret } from "./auth";
import { aiSettings, auditLog, chatMessage } from "./schema";
import { resolveAuditActor } from "./ai-audit";
import { mayManageAccess, type AccessGrant } from "./access-policy";

export type AiSettingsPublic = {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  /** Tool round-trips one answer may take in the LINE bot. */
  maxSteps: number;
  hasApiKey: boolean;
  updatedAt: number | null;
};

export type AiSettingsInput = {
  baseUrl?: string;
  apiKey?: string | null; // null/omitted = keep existing
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxSteps?: number;
};

/** 1 round-trip answers nothing with a tool; 6 is a loop, not an answer. */
export const MAX_STEPS_MIN = 1;
export const MAX_STEPS_MAX = 6;

export function clampMaxSteps(value: number): number {
  return Math.min(MAX_STEPS_MAX, Math.max(MAX_STEPS_MIN, Math.round(value)));
}

export const DEFAULT_SETTINGS: Omit<AiSettingsPublic, "updatedAt"> = {
  baseUrl: "https://llm.kovaspire.com",
  model: "openrouter/deepseek-v3",
  systemPrompt:
    "คุณคือผู้ช่วยข้อมูลของระบบ LaundryTwin สำหรับผู้จัดการหรือเจ้าของร้านซักรีด\n" +
    "ตอบเป็นภาษาไทย กระชับ และอ้างอิงข้อมูลจากเครื่องมือ (tools) เท่านั้น\n" +
    "ถ้าข้อมูลเป็นข้อมูลจำลอง (synthetic หรือ mixed) ให้บอกผู้ใช้อย่างชัดเจน\n" +
    "ตัวเลขเงินเป็นสตางค์ (satang) ให้แปลงเป็นบาทก่อนแสดง และห้ามเขียนหน่วยสตางค์หรือสมการแปลงในคำตอบ ให้เขียนเฉพาะจำนวนเงินเป็นบาท",
  temperature: 70,
  maxSteps: 4,
  hasApiKey: false
};

function encryptionKey(): Buffer {
  return createHash("sha256").update(resolveServerSecret()).digest();
}

export function encryptApiKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptApiKey(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Read the stored settings; falls back to DEFAULT_SETTINGS when absent. */
export function getAiSettings(): AiSettingsPublic {
  const row = db.select().from(aiSettings).where(eq(aiSettings.id, "default")).get();
  if (!row) {
    return { ...DEFAULT_SETTINGS, updatedAt: null };
  }
  return {
    baseUrl: row.baseUrl,
    model: row.model,
    systemPrompt: row.systemPrompt,
    temperature: row.temperature,
    maxSteps: row.maxSteps,
    hasApiKey: Boolean(row.apiKeyEncrypted),
    updatedAt: row.updatedAt.getTime()
  };
}

/** Read settings including the decrypted key (server-side callers only). */
export function getAiSettingsWithKey(): {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxSteps: number;
} {
  const row = db.select().from(aiSettings).where(eq(aiSettings.id, "default")).get();
  const base = row ?? null;
  return {
    baseUrl: base?.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
    apiKey: base?.apiKeyEncrypted ? decryptApiKey(base.apiKeyEncrypted) : null,
    model: base?.model ?? DEFAULT_SETTINGS.model,
    systemPrompt: base?.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
    temperature: base?.temperature ?? DEFAULT_SETTINGS.temperature,
    maxSteps: base?.maxSteps ?? DEFAULT_SETTINGS.maxSteps
  };
}

/** Upsert settings; apiKey === null keeps the stored key. Owner-only. */
export function updateAiSettings(input: AiSettingsInput, actorUserId: string): AiSettingsPublic {
  const existing = db.select().from(aiSettings).where(eq(aiSettings.id, "default")).get();
  const now = new Date();
  // `updated_by_user_id` is a foreign key into `user(id)` too, so the same
  // resolution applies to both columns (see resolveAuditActor).
  const actor = resolveAuditActor(actorUserId);

  const next = {
    id: "default" as const,
    baseUrl: input.baseUrl ?? existing?.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
    apiKeyEncrypted:
      input.apiKey === undefined
        ? (existing?.apiKeyEncrypted ?? null)
        : input.apiKey === null || input.apiKey === ""
          ? null
          : encryptApiKey(input.apiKey),
    model: input.model ?? existing?.model ?? DEFAULT_SETTINGS.model,
    systemPrompt: input.systemPrompt ?? existing?.systemPrompt ?? DEFAULT_SETTINGS.systemPrompt,
    temperature: input.temperature ?? existing?.temperature ?? DEFAULT_SETTINGS.temperature,
    maxSteps: input.maxSteps === undefined
      ? (existing?.maxSteps ?? DEFAULT_SETTINGS.maxSteps)
      : clampMaxSteps(input.maxSteps),
    updatedByUserId: actor.actorUserId,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now
  };

  db.insert(aiSettings).values(next).onConflictDoUpdate({ target: aiSettings.id, set: next }).run();

  db.insert(auditLog)
    .values({
      id: randomUUID(),
      actorUserId: actor.actorUserId,
      action: "ai_settings.update",
      target: "ai_settings:default",
      detail: JSON.stringify({
        baseUrl: next.baseUrl,
        model: next.model,
        temperature: next.temperature,
        maxSteps: next.maxSteps,
        keyChanged: input.apiKey !== undefined && input.apiKey !== null && input.apiKey !== "",
        ...(actor.actorUnresolved ? { actorUnresolved: true } : {})
      }),
      createdAt: now
    })
    .run();

  return {
    baseUrl: next.baseUrl,
    model: next.model,
    systemPrompt: next.systemPrompt,
    temperature: next.temperature,
    maxSteps: next.maxSteps,
    hasApiKey: Boolean(next.apiKeyEncrypted),
    updatedAt: now.getTime()
  };
}

/** Owner check helper for routes. */
export function isOwner(grants: AccessGrant[]): boolean {
  return mayManageAccess(grants);
}

// ---- Chat history (30-day retention) ----

export const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function addChatMessage(input: {
  threadId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string | null;
}): void {
  db.insert(chatMessage)
    .values({
      id: randomUUID(),
      threadId: input.threadId,
      userId: input.userId,
      role: input.role,
      content: input.content,
      model: input.model ?? null,
      createdAt: new Date()
    })
    .run();
}

export function listChatMessages(threadId: string, userId: string, limit = 100) {
  return db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.threadId, threadId), eq(chatMessage.userId, userId)))
    .orderBy(desc(chatMessage.createdAt))
    .limit(limit)
    .all();
}

/**
 * Purge messages older than the retention window. Returns deleted count.
 *
 * The comparison binds `cutoff.getTime()`, an integer, not a `Date`: the column
 * is `integer` in milliseconds mode, and better-sqlite3 rejects a `Date` param
 * outright ("can only bind numbers, strings, bigints, buffers, and null"). The
 * route answered 500 on its first exercised call — found by `ai-audit.test.ts`
 * on 2026-11-09, not in production.
 */
export function purgeExpiredChatMessages(now = new Date()): number {
  const cutoff = now.getTime() - CHAT_RETENTION_MS;
  const result = db.delete(chatMessage).where(sql`${chatMessage.createdAt} < ${cutoff}`).run();
  return result.changes ?? 0;
}
