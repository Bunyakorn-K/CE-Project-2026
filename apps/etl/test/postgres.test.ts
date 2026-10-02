import { describe, expect, it } from "vitest";
import type { IngestedTemperatureCursor } from "../src/watermark.js";
import {
  createPostgresSource,
  postgresPoolOptions,
  type PoolLike,
} from "../src/postgres.js";

type Captured = { sql: string; values?: unknown[] };

function fakePool(captured: Captured[], rows: Record<string, unknown>[] = []) {
  const pool: PoolLike = {
    async query<T>(sql: string, values?: unknown[]) {
      captured.push({ sql, values });
      return { rows: rows as T[] };
    },
    async end() {},
  };
  return pool;
}

const CURSOR = { key: "occurred_at" as const, at: "2026-09-25T00:00:00.000Z", seq: "0", id: "" };
const LEGACY_CURSOR: IngestedTemperatureCursor = { at: "2026-09-25T00:00:00.000Z", seq: "0", id: "" };

describe("postgres pool options", () => {
  it("bounds every source query so a blocked statement cannot hang the ETL", () => {
    const options = postgresPoolOptions({ connectionString: "postgresql://x/y" });
    expect(options.statement_timeout).toBeGreaterThan(0);
    // The client-side backstop must outlast the server-side statement timeout so
    // the real Postgres error is what surfaces, not a generic read timeout.
    expect(options.query_timeout).toBeGreaterThan(options.statement_timeout!);
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(options.idle_in_transaction_session_timeout).toBeGreaterThan(0);
    expect(options.max).toBe(4);
    expect(options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("forces a UTC session so the keyset cursor cannot shift with the server timezone", () => {
    const options = postgresPoolOptions({ connectionString: "postgresql://x/y" });
    expect(options.options).toContain("timezone=UTC");
  });

  it("honours explicit timeout overrides", () => {
    const options = postgresPoolOptions({
      connectionString: "postgresql://x/y",
      statementTimeoutMs: 1000,
      connectTimeoutMs: 2000,
      idleTransactionTimeoutMs: 3000,
    });
    expect(options.statement_timeout).toBe(1000);
    expect(options.connectionTimeoutMillis).toBe(2000);
    expect(options.idle_in_transaction_session_timeout).toBe(3000);
  });
});

describe("listTemperatureSince", () => {
  it("keysets on occurred_at, not the unindexed ingested_at", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured),
    });

    await source.listTemperatureSince(CURSOR, {
      limit: 20000,
      until: new Date("2026-09-24T00:00:00.000Z"),
    });

    expect(captured).toHaveLength(1);
    const { sql, values } = captured[0]!;
    // The keyset and the ORDER BY must both be the indexed, partition-key column.
    expect(sql).toContain("(s.occurred_at, s.seq, s.event_id) > ($1, $2, $3)");
    expect(sql).toContain("ORDER BY s.occurred_at ASC, s.seq ASC, s.event_id ASC");
    // A bare range on the partition key so the planner can prune without
    // reasoning about the row comparison's OR expansion.
    expect(sql).toContain("s.occurred_at >= $1");
    // The lag guard bounds the scan on the same column.
    expect(sql).toContain("s.occurred_at <= $4");
    // ingested_at must not appear in the predicate or the ordering any more.
    expect(sql).not.toMatch(/\(s\.ingested_at/);
    expect(sql).not.toMatch(/ORDER BY s\.ingested_at/);
    expect(sql).not.toMatch(/s\.ingested_at\s*[<>]/);
    // ingested_at is still carried as payload for the warehouse column.
    expect(sql).toContain("s.ingested_at,");
    expect(values).toEqual([
      "2026-09-25T00:00:00.000Z",
      "0",
      "",
      new Date("2026-09-24T00:00:00.000Z"),
      20000,
    ]);
  });

  it("omits the upper bound when no lag guard is given (ops full walk)", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured),
    });

    await source.listTemperatureSince(CURSOR, { limit: 50000 });

    const { sql, values } = captured[0]!;
    expect(sql).not.toContain("s.occurred_at <=");
    expect(values).toEqual(["2026-09-25T00:00:00.000Z", "0", "", 50000]);
  });
});

describe("resolveTemperatureCursorFromIngested", () => {
  it("re-anchors a legacy ingested_at cursor onto the occurred_at keyset", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured, [
        { occurred_at: new Date("2026-09-24T23:59:59.000Z"), seq: "7", event_id: "evt-7" },
      ]),
    });

    const migrated = await source.resolveTemperatureCursorFromIngested(LEGACY_CURSOR);

    expect(migrated).toEqual({
      key: "occurred_at",
      at: "2026-09-24T23:59:59.000Z",
      seq: "7",
      id: "evt-7",
    });
    const { sql, values } = captured[0]!;
    expect(sql).toContain("(s.ingested_at, s.seq, s.event_id) <= ($1, $2, $3)");
    expect(sql).toContain("ORDER BY s.ingested_at DESC, s.seq DESC, s.event_id DESC");
    expect(values).toEqual(["2026-09-25T00:00:00.000Z", "0", ""]);
  });

  it("returns null when the source has no row at or before the legacy cursor", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured, []),
    });
    expect(await source.resolveTemperatureCursorFromIngested(LEGACY_CURSOR)).toBeNull();
  });

  it("widens the budget for the scan and restores it before the connection returns to the pool", async () => {
    const captured: Captured[] = [];
    let released = 0;
    const pool: PoolLike = {
      async query<T>(sql: string, values?: unknown[]) {
        captured.push({ sql, values });
        return { rows: [] as T[] };
      },
      async connect() {
        return {
          query: this.query.bind(this),
          async release() {
            released += 1;
          },
        };
      },
      async end() {},
    };
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      statementTimeoutMs: 1000,
      pool,
    });

    await source.resolveTemperatureCursorFromIngested(LEGACY_CURSOR);

    const budgets = captured.filter((c) => c.sql.includes("set_config")).map((c) => c.values?.[0]);
    expect(budgets).toEqual(["600000", "1000"]);
    expect(released).toBe(1);
  });
});

describe("coverage audit helpers", () => {
  // The window the audit compares must be a range BOTH sides can speak about.
  // Without the source's own first day, the window is anchored on the
  // warehouse alone and every day before the source's oldest row comes back
  // "absent from source" — a gap manufactured by the question, not the data.
  it("reports the source's own first usage day", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured, [{ day: "2026-04-28" }]),
    });

    expect(await source.firstUsageDay()).toBe("2026-04-28");
  });

  // An empty table yields min() = NULL, which must not become the string "null"
  // and then a day every window is clamped against.
  it("reports null rather than a fake day when the source is empty", async () => {
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool([], [{ day: null }]),
    });

    expect(await source.firstUsageDay()).toBeNull();
  });

  it("keys the created_at view on created_at, the ETL's own cursor column", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured, [{ day: "2026-07-21", rows: 4 }]),
    });

    expect(await source.auditUsageDaysByCreatedAt("2026-07-20", "2026-07-21")).toEqual({
      "2026-07-21": 4,
    });
    const sql = captured.at(-1)!.sql;
    expect(sql).toContain("(created_at)::date");
    // Null created_at contributes to no day, so it must not be counted into one.
    expect(sql).toContain("created_at IS NOT NULL");
  });

  it("keys the started_at view on started_at and drops the rows that lack it", async () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured, [{ day: "2026-07-21", rows: 1 }]),
    });

    expect(await source.auditUsageDaysByStartedAt("2026-07-20", "2026-07-21")).toEqual({
      "2026-07-21": 1,
    });
    const sql = captured.at(-1)!.sql;
    expect(sql).toContain("(started_at)::date");
    expect(sql).toContain("started_at IS NOT NULL");
  });

  // An inclusive range has to include its final day, or the newest business day
  // is reported as a gap — the one day an operator most needs to trust.
  it("widens the upper bound by a day so the final day is included", () => {
    const captured: Captured[] = [];
    const source = createPostgresSource({
      connectionString: "postgresql://x/y",
      pool: fakePool(captured, []),
    });

    void source.auditUsageDaysByStartedAt("2026-07-20", "2026-07-21");
    expect(captured[0].values).toEqual(["2026-07-20", "2026-07-21"]);
    expect(captured[0].sql).toContain("INTERVAL '1 day'");
  });
});
