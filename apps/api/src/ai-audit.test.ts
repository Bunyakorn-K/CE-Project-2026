import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, initializeDatabase } from "./db";
import { auditLog, chatMessage, user } from "./schema";
import { purgeExpiredChatMessages, CHAT_RETENTION_MS } from "./ai-settings";
import {
  argsDigest,
  argsKeys,
  recordAiChat,
  recordAiToolCall,
  rowsInToolResult,
  runAuditedToolCall
} from "./ai-audit";

const testUserIds: string[] = [];
const testRowIds: string[] = [];

function seedUser(): string {
  const id = randomUUID();
  const now = new Date();
  db.insert(user)
    .values({ id, name: "Audit Test", email: `audit-${id}@laundrytwin.test`, emailVerified: false, image: null, createdAt: now, updatedAt: now })
    .run();
  testUserIds.push(id);
  return id;
}

function auditRows(action: string) {
  return db.select().from(auditLog).all().filter((row) => row.action === action);
}

function detailOf(rowId: string) {
  const row = auditRowsForId(rowId);
  if (!row) throw new Error(`no audit row ${rowId}`);
  return JSON.parse(row.detail) as Record<string, unknown>;
}

function auditRowsForId(id: string) {
  return db.select().from(auditLog).all().find((row) => row.id === id);
}

beforeEach(() => {
  initializeDatabase();
});

afterEach(() => {
  // Only rows this file created: ids it remembered, plus every ai.* row for the
  // seeded users. The production database is never touched by a test run.
  const all = db.select().from(auditLog).all();
  for (const row of all) {
    if (testRowIds.includes(row.id)) db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(row.id);
    else if ((row.action === "ai.chat" || row.action === "ai.tool_call") && row.actorUserId && testUserIds.includes(row.actorUserId)) {
      db.$client.prepare("DELETE FROM audit_log WHERE id = ?").run(row.id);
    }
  }
  if (testUserIds.length > 0) {
    const ph = testUserIds.map(() => "?").join(", ");
    db.$client.prepare(`DELETE FROM chat_message WHERE user_id IN (${ph})`).run(...testUserIds);
    db.$client.prepare(`DELETE FROM audit_log WHERE actor_user_id IN (${ph})`).run(...testUserIds);
    db.$client.prepare(`DELETE FROM user WHERE id IN (${ph})`).run(...testUserIds);
  }
  testRowIds.length = 0;
  testUserIds.length = 0;
});

describe("argsDigest", () => {
  it("is order-independent, so {a,b} and {b,a} digest the same", () => {
    expect(argsDigest({ from: "2026-09-01", to: "2026-09-02" })).toBe(
      argsDigest({ to: "2026-09-02", from: "2026-09-01" })
    );
  });

  it("is order-independent for nested objects too", () => {
    expect(argsDigest({ scope: { a: 1, b: 2 } })).toBe(argsDigest({ scope: { b: 2, a: 1 } }));
  });

  it("changes when a value changes", () => {
    expect(argsDigest({ branchId: "branch-01" })).not.toBe(argsDigest({ branchId: "branch-02" }));
  });

  it("is a SHA-256 hex digest, not the arguments", () => {
    const digest = argsDigest({ branchId: "secret-branch-value" });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain("secret-branch-value");
  });
});

describe("argsKeys", () => {
  it("lists sorted names and never a value", () => {
    expect(argsKeys({ to: "2026-09-02", branchId: "branch-07", from: "2026-09-01" })).toEqual([
      "branchId",
      "from",
      "to"
    ]);
  });
});

describe("rowsInToolResult", () => {
  it("counts the envelope's data rows", () => {
    expect(rowsInToolResult(JSON.stringify({ data: [{}, {}], meta: {} }))).toBe(2);
  });

  it("reports null rather than 0 when the answer cannot be counted", () => {
    expect(rowsInToolResult("not json")).toBeNull();
    expect(rowsInToolResult(JSON.stringify({ meta: {} }))).toBeNull();
  });
});

describe("recordAiToolCall", () => {
  it("writes one row with a digest, the argument names, and no argument value", () => {
    const userId = seedUser();
    const id = recordAiToolCall({
      actorUserId: userId,
      model: "test-model",
      tool: "get_cycles_daily",
      toolCallId: "call-1",
      args: { branchId: "branch-secret-42", from: "2026-11-01", to: "2026-11-09" },
      outcome: "ok",
      resultRows: 9,
      durationMs: 12
    });
    testRowIds.push(id);

    const row = auditRowsForId(id);
    expect(row?.action).toBe("ai.tool_call");
    expect(row?.target).toBe("get_cycles_daily");
    expect(row?.actorUserId).toBe(userId);

    const detail = detailOf(id);
    expect(detail.argsDigest).toBe(argsDigest({ branchId: "branch-secret-42", from: "2026-11-01", to: "2026-11-09" }));
    expect(detail.argsKeys).toEqual(["branchId", "from", "to"]);
    expect(detail.model).toBe("test-model");
    expect(detail.toolCallId).toBe("call-1");
    expect(detail.resultRows).toBe(9);
    expect(detail.outcome).toBe("ok");
    // The value must not be anywhere in the row.
    expect(row?.detail).not.toContain("branch-secret-42");
    expect(row?.detail).not.toContain("2026-11-01");
  });

  it("keeps an environment value out of the row even when it is an argument", () => {
    const userId = seedUser();
    const probe = `env-probe-${randomUUID()}`;
    process.env.AI_AUDIT_PROBE = probe;
    try {
      const id = recordAiToolCall({
        actorUserId: userId,
        model: "test-model",
        tool: "get_revenue_daily",
        toolCallId: null,
        args: { token: probe },
        outcome: "ok",
        resultRows: 1,
        durationMs: 3
      });
      testRowIds.push(id);
      expect(auditRowsForId(id)?.detail).not.toContain(probe);
    } finally {
      delete process.env.AI_AUDIT_PROBE;
    }
  });
});

describe("runAuditedToolCall", () => {
  it("writes exactly one row on success and returns the tool text", async () => {
    const userId = seedUser();
    const before = auditRows("ai.tool_call").length;
    const text = await runAuditedToolCall({
      tool: "get_utilization_heatmap",
      toolCallId: "call-ok",
      actorUserId: userId,
      model: "test-model",
      args: { branchId: "b1" },
      execute: async () => JSON.stringify({ data: [{}, {}, {}], meta: {} })
    });
    const after = auditRows("ai.tool_call");
    expect(after.length - before).toBe(1);
    const row = after[after.length - 1];
    testRowIds.push(row.id);
    expect(JSON.parse(row.detail).resultRows).toBe(3);
    expect(text).toContain("data");
  });

  it("writes exactly one row when the tool throws, and re-throws", async () => {
    const userId = seedUser();
    const before = auditRows("ai.tool_call").length;
    await expect(
      runAuditedToolCall({
        tool: "get_temperature_curve",
        toolCallId: "call-fail",
        actorUserId: userId,
        model: "test-model",
        args: { branchId: "b1", machineId: "m1" },
        execute: async () => {
          throw new TypeError("tool exploded with a secret-looking message");
        }
      })
    ).rejects.toThrow("tool exploded");
    const after = auditRows("ai.tool_call");
    expect(after.length - before).toBe(1);
    const row = after[after.length - 1];
    testRowIds.push(row.id);
    const detail = JSON.parse(row.detail);
    expect(detail.outcome).toBe("error");
    expect(detail.errorName).toBe("TypeError");
    expect(detail.resultRows).toBeNull();
    // The message is not stored, so nothing it quoted can leak.
    expect(row.detail).not.toContain("secret-looking message");
  });
});

describe("recordAiChat", () => {
  it("writes one row per chat request with model, message count and tool usage", () => {
    const userId = seedUser();
    const id = recordAiChat({
      actorUserId: userId,
      model: "test-model",
      threadId: "thread-1",
      messageCount: 1,
      usedTools: false,
      outcome: "ok"
    });
    testRowIds.push(id);
    const detail = detailOf(id);
    expect(auditRowsForId(id)?.action).toBe("ai.chat");
    expect(detail).toMatchObject({ model: "test-model", messageCount: 1, usedTools: false, outcome: "ok" });
  });
});

describe("resolveAuditActor", () => {
  it("records an actor that is not a persisted user as unresolved instead of failing", () => {
    // The development bypass principal is deliberately not a row in `user`, and
    // audit_log.actor_user_id is a foreign key. Storing it verbatim raises
    // SQLITE_CONSTRAINT_FOREIGNKEY and the request 500s.
    const id = recordAiChat({
      actorUserId: "development-owner",
      model: "test-model",
      threadId: "thread-dev",
      messageCount: 1,
      usedTools: false,
      outcome: "ok"
    });
    testRowIds.push(id);
    const row = auditRowsForId(id);
    expect(row?.actorUserId).toBeNull();
    expect(JSON.parse(row?.detail ?? "{}").actorUnresolved).toBe(true);
  });
});

describe("purge", () => {
  it("deletes conversation content only, leaving the audit trail intact", () => {
    const userId = seedUser();
    const old = new Date(Date.now() - CHAT_RETENTION_MS - 24 * 60 * 60 * 1000);
    db.insert(chatMessage)
      .values({ id: randomUUID(), threadId: "thread-old", userId, role: "user", content: "old question", model: "test-model", createdAt: old })
      .run();
    const auditId = recordAiChat({
      actorUserId: userId,
      model: "test-model",
      threadId: "thread-old",
      messageCount: 1,
      usedTools: false,
      outcome: "ok"
    });
    testRowIds.push(auditId);

    const deleted = purgeExpiredChatMessages();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(db.select().from(chatMessage).all().filter((row) => row.threadId === "thread-old")).toHaveLength(0);
    // The record that a call happened survives the deletion of what was said.
    expect(auditRowsForId(auditId)).toBeTruthy();
  });
});
