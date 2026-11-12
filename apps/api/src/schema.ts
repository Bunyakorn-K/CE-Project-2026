import { sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
// LLM gateway: base_url + api_key let an owner point LaundryTwin at any
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
  /** Tool round-trips one answer may take. 2 meant a single call; 4 allows a follow-up. */
  maxSteps: integer("max_steps").notNull().default(4),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

// Chat history for the AI playground (30-day retention; purge job in ai.ts).
// Alert delivery settings, editable by an owner in the backoffice.
//
// These were environment variables first, which meant changing the re-notify
// floor or the monthly cap required a redeploy — for a number that depends on
// how noisy the shop is this week, not on how the code is built.
/**
 * The daily digest: one message a day, if — and only if — an owner turns it on and
 * names who receives it. Off by default, with no recipients, because a bot that
 * starts talking on its own is a decision for the shop, not for a deploy.
 */
export const digestSettings = sqliteTable("digest_settings", {
  id: text("id").primaryKey().default("default"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** Bangkok time of day, 0-23 / 0-59. */
  sendHour: integer("send_hour").notNull().default(7),
  sendMinute: integer("send_minute").notNull().default(0),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

/**
 * A question worth asking again.
 *
 * The golden set exists because of a real failure: the gateway was switched and the
 * assistant started answering about 2026-07-01 — nothing compared the new model with
 * the old one, so the first person to notice was the owner, in LINE. These are the
 * questions a run replays.
 */
export const evalCase = sqliteTable("eval_case", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  /** What a correct answer must mention, e.g. a branch name. Optional. */
  expectContains: text("expect_contains"),
  /** Where it came from: "chat" (a real question) or "canonical". */
  origin: text("origin").notNull().default("canonical"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

export const evalRun = sqliteTable("eval_run", {
  id: text("id").primaryKey(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  /** The model this run is being compared against, when there is one. */
  baselineModel: text("baseline_model"),
  status: text("status").notNull().default("running"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" })
});

export const evalResult = sqliteTable("eval_result", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  caseId: text("case_id").notNull(),
  question: text("question").notNull(),
  /** The answer, truncated: enough to read, not a second copy of the transcript. */
  answer: text("answer").notNull(),
  score: integer("score").notNull(),
  checks: text("checks").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

/**
 * One tap on "มีประโยชน์" or "ไม่ตรงคำถาม" under an answer.
 *
 * WHY A TABLE AND NOT JUST A SCORE. The score is a number in an evaluator's tool; this
 * is the only place the shop's own staff say whether the answer was right. It is keyed
 * by turn, so tapping twice changes nothing, and it carries no text.
 */
export const chatFeedback = sqliteTable(
  "chat_feedback",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id").notNull(),
    lineUserId: text("line_user_id").notNull(),
    /** `up` or `down`. */
    rating: text("rating").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => ({
    onePerTurn: uniqueIndex("chat_feedback_turn_idx").on(table.turnId, table.lineUserId)
  })
);

/**
 * One row per span, kept locally.
 *
 * WHY BOTH THIS AND OTLP. The collector is optional and off by default; the shop's
 * own record of "what was slow, which tool, how many tokens" must not depend on
 * somebody having configured an endpoint. This table is the L1 floor, and the same
 * spans are exported when a collector is set.
 *
 * Metadata only: model, tool name, counts, durations, status. Never the question or
 * the answer — those live in `chat_turn`, with its own retention.
 */
export const aiTrace = sqliteTable("ai_trace", {
  id: text("id").primaryKey(),
  /** The answer this span belongs to, so a tool span can be shown under its turn. */
  turnId: text("turn_id"),
  /** `chat.answer` or `tool.<name>`. */
  name: text("name").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  /** JSON of the span's attributes. Metadata only, by construction. */
  attributes: text("attributes").notNull().default("{}"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

/**
 * What the chat remembers about a person between conversations.
 *
 * Only settings they stated on purpose ("สาขาประจำของฉันคือ…"), never inferred ones:
 * a preference the system guessed is a preference the user cannot see, and the next
 * answer would quietly be about the wrong branch.
 */
/**
 * A question held while the person picks a branch.
 *
 * It is a row rather than a variable because the picker is a separate webhook
 * request: the tap that answers arrives after the message that asked, possibly
 * after a restart. One row per person — a new question replaces the held one,
 * because answering an older question than the one on screen would be worse than
 * answering none.
 */
export const chatPending = sqliteTable(
  "chat_pending",
  {
    lineUserId: text("line_user_id").primaryKey(),
    question: text("question").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  }
);

export const chatPreference = sqliteTable(
  "chat_preference",
  {
    lineUserId: text("line_user_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.lineUserId, table.key] })
  })
);

/** Who receives the digest. Added by hand; an empty table means nobody. */
export const digestRecipient = sqliteTable("digest_recipient", {
  lineUserId: text("line_user_id").primaryKey(),
  addedByUserId: text("added_by_user_id").references(() => user.id, { onDelete: "set null" }),
  addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull()
});

/**
 * One row per recipient per day, which is what makes the digest idempotent: a DAG
 * that retries five minutes later, or a redeploy that re-runs the check, sends
 * nothing the second time.
 */
export const digestSent = sqliteTable("digest_sent", {
  id: text("id").primaryKey(),
  /** `YYYY-MM-DD`, the shop's day. */
  day: text("day").notNull(),
  lineUserId: text("line_user_id").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull()
});

export const alertSettings = sqliteTable("alert_settings", {
  id: text("id").primaryKey().default("default"),
  /** Hours before the same rule may notify again. */
  renotifyHours: integer("renotify_hours").notNull().default(12),
  /** Messages allowed per calendar month, across all rules and recipients. */
  monthlyBudget: integer("monthly_budget").notNull().default(200),
  updatedByUserId: text("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

// One row per answered message in LINE: what was asked, what was said, and how
// it was produced. It is the bot's memory (the last few turns are fed back as
// context) and its observability (latency, steps, reply-vs-push) in one place.
//
// Separate from `chat_message`, which belongs to the backoffice playground: the
// playground has threads and a user who is sitting in a browser, the bot has one
// ongoing conversation per LINE account and no thread id.
export const chatTurn = sqliteTable("chat_turn", {
  id: text("id").primaryKey(),
  lineUserId: text("line_user_id").notNull(),
  userText: text("user_text").notNull(),
  answerText: text("answer_text").notNull(),
  model: text("model").notNull().default(""),
  /** Tool round-trips the model actually used. */
  steps: integer("steps").notNull().default(0),
  toolCalls: integer("tool_calls").notNull().default(0),
  /**
   * Set when a tool answered with an error envelope. The row stays as a record but is
   * never fed back as context: a model reads its own failed answer as a fact and
   * repeats it — which is how "revenue is disabled" outlived the flag by eight turns.
   */
  toolError: integer("tool_error").notNull().default(0),
  /**
   * Which branches the answer was computed for ("all", or the ids joined).
   *
   * A turn answered from every branch is not context for a question scoped to one:
   * the model reads the wider answer as "already answered" and repeats it, which is
   * how a narrowed question came back with the other branch's numbers in it.
   */
  scopeKey: text("scope_key").notNull().default("all"),
  latencyMs: integer("latency_ms").notNull().default(0),
  /** Tokens for the whole loop; 0 when the gateway does not report usage. */
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  /** "reply" is free; "push" spends one of the 300 a month. */
  delivered: text("delivered").notNull().default("reply"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
});

// The rich menu ids LINE assigned, one row per role key.
//
// LINE has no "update a menu" call, so a sync creates new menus and deletes the
// old ones; the ids therefore change on every sync and cannot be constants. They
// are stored rather than looked up on each login: the login path must not depend
// on a second API call succeeding.
export const richMenu = sqliteTable("rich_menu", {
  key: text("key").primaryKey(),
  richMenuId: text("rich_menu_id").notNull(),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull()
});

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
  alertSettings,
  chatTurn,
  richMenu,
  chatMessage
};
