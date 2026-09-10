import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull()
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" })
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
});

export const accessGrant = sqliteTable("access_grant", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "manager", "technician"] }).notNull(),
  branchId: text("branch_id"),
  grantedByUserId: text("granted_by_user_id").references(() => user.id, { onDelete: "set null" }),
  grantedAt: integer("granted_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" })
});

export const liffIdentity = sqliteTable("liff_identity", {
  lineUserId: text("line_user_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const liffSession = sqliteTable("liff_session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const liffAccessRequest = sqliteTable("liff_access_request", {
  id: text("id").primaryKey(),
  lineUserId: text("line_user_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
  approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  approvedByUserId: text("approved_by_user_id").references(() => user.id, { onDelete: "set null" })
});

export const alertAcknowledgement = sqliteTable("alert_acknowledgement", {
  id: text("id").primaryKey(),
  irisAlertId: text("iris_alert_id").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target").notNull(),
  detail: text("detail").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const alertNotification = sqliteTable(
  "alert_notification",
  {
    id: text("id").primaryKey(),
    irisAlertId: text("iris_alert_id").notNull(),
    lineUserId: text("line_user_id").notNull(),
    branchId: text("branch_id"),
    machineId: text("machine_id"),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    evidence: text("evidence").notNull().default("{}"),
    status: text("status", { enum: ["sending", "sent", "failed"] }).notNull(),
    cooldownKey: text("cooldown_key"),
    attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    error: text("error")
  },
  (table) => [uniqueIndex("alert_notification_dedup_idx").on(table.irisAlertId, table.lineUserId)]
);

// AI console settings (backoffice, 2026-09-10). Single-row config for the
// LLM gateway: base_url + api_key let an owner point LaundroTwin at any
// OpenAI-compatible endpoint (default: Bifrost https://llm.kovaspire.com).
// The key is stored encrypted-at-rest (see ai-settings.ts) and NEVER sent to
// the browser; only `hasApiKey` masks are returned. Model selection +
// system prompt template drive bot/conversation.ts.
export const aiSettings = sqliteTable("ai_settings", {
  id: text("id").primaryKey().default("default"),
  baseUrl: text("base_url").notNull(),
  apiKeyEncrypted: text("api_key_encrypted"),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  temperature: integer("temperature").notNull().default(70), // 0-100, /100 at call time
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

// Chat history for the AI playground (30-day retention; purge job in ai.ts).
export const chatMessage = sqliteTable("chat_message", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  model: text("model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const schema = {
  user,
  session,
  account,
  verification,
  accessGrant,
  liffIdentity,
  liffSession,
  liffAccessRequest,
  alertAcknowledgement,
  auditLog,
  alertNotification,
  aiSettings,
  chatMessage
};
