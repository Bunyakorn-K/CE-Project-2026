// Postgres source adapter. Reads durable machine-usage data from the IRIS
// `iris_project` database on the VPS. All queries are parameterized; rows are
// typed at the boundary and transformed in transform.ts (no raw values leak
// into SQL text).
//
// Temperature read: keyed on `occurred_at`, not `ingested_at` (2026-09-29).
// The ETL hung for four days from 2026-09-25 because every temperature page
// scanned the whole table. In IRIS (read 2026-09-29 at 813ffa7):
//   * `machine_temperature_sample` is `PARTITION BY RANGE (occurred_at)`, so a
//     predicate on `ingested_at` prunes nothing and touches every partition.
//   * It has an index on `occurred_at` (migration 0030) and NO index on
//     `ingested_at` anywhere in the 203-migration history.
//   * It has no retention: IRIS's rotate cron covers `machine_event` only
//     (0030 defers `machine_temperature_sample` to a follow-up that never
//     happened), so the scan grew monotonically until a page stopped finishing.
// `occurred_at` is indexed, is the partition key, and is the column the
// warehouse itself is ordered and partitioned by.

import pg from "pg";
import type {
  IngestedTemperatureCursor,
  TemperatureCursor,
  UsageCursor,
} from "./watermark.js";

const { Pool } = pg;

export type UsageRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  usage_id: string;
  program_id: number;
  program_name: string;
  started_at: Date | null;
  finished_at: Date | null;
  duration_min: number;
  amount_satang: number;
  status: string;
  initiated_via: string;
  temp_level: string | null;
  attribution_state: string;
  /**
   * NOT NULL in IRIS (migration 0052), so the driver never yields null. Typed
   * nullable anyway: the derived classifier treats a missing/empty reason as
   * unclassified, and a narrowed type would assert a constraint this repository
   * cannot verify against the live database.
   */
  attribution_reason: string | null;
  attribution_source: string | null;
  machine_session_id: string | null;
  source_event_id: string;
  created_at: Date;
  updated_at: Date;
};

export type TemperatureSampleRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  event_id: string;
  seq: string;
  frame_seq: string | null;
  /**
   * Non-null by construction: it is the device event time written in the same
   * INSERT as `ingested_at`, and it is the warehouse's partition key, which
   * cannot hold NULL. A NULL here would fall outside the keyset comparison and
   * the row would never be read.
   */
  occurred_at: Date;
  ingested_at: Date;
  temperature_f: number;
  phase: string | null;
};

export type BranchRow = {
  tenant_id: string;
  branch_id: string;
  name: string;
  timezone: string;
  status: string;
  updated_at: Date;
};

export type MachineRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  code: string;
  kind: string;
  modbus_address: number;
  status: string;
  updated_at: Date;
  deleted_at: Date | null;
};

export type MachineUsageSource = {
  listBranches(options?: { cursor?: string; limit?: number }): Promise<BranchRow[]>;
  listMachines(options?: { cursor?: string; limit?: number }): Promise<MachineRow[]>;
  listUsageSince(since: UsageCursor, options?: { limit?: number }): Promise<UsageRow[]>;
  listTemperatureSince(
    since: TemperatureCursor,
    options?: { limit?: number; until?: Date }
  ): Promise<TemperatureSampleRow[]>;
  /**
   * One-time re-anchor of a pre-2026-09-29 `ingested_at` cursor onto the
   * `occurred_at` keyset. Returns null when the source holds no row at or
   * before the legacy cursor.
   */
  resolveTemperatureCursorFromIngested(
    legacy: IngestedTemperatureCursor
  ): Promise<TemperatureCursor | null>;
  /**
   * Per-day row counts for the coverage audit, keyed on `created_at`.
   *
   * Read-only and deliberately separate from `listUsageSince`: that walks the
   * ETL's incremental cursor, whereas the audit needs a whole window at once.
   */
  auditUsageDaysByCreatedAt(from: string, to: string): Promise<Record<string, number>>;
  /**
   * The source's own earliest `created_at` day, or null when it holds no usage
   * rows at all.
   *
   * The coverage audit needs it to bound the window it compares. Without it the
   * window is anchored on the warehouse alone, which asks the source about days
   * that predate its oldest row and gets "nothing" back for every one of them —
   * a gap the data does not contain, manufactured by the question.
   */
  firstUsageDay(): Promise<string | null>;
  /**
   * Per-day row counts for the coverage audit, keyed on `started_at` — the
   * business day. Rows with a null `started_at` contribute to no day at all,
   * which is the whole distinction the audit exists to measure.
   */
  auditUsageDaysByStartedAt(from: string, to: string): Promise<Record<string, number>>;
  close(): Promise<void>;
};

/** The slice of pg.Pool this adapter uses; also the seam the tests drive. */
export type PoolLike = {
  query<R>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>;
  /** Present on a real pg.Pool; absent on the bare test double. */
  connect?(): Promise<QueryableClient>;
  end(): Promise<void>;
};

/** A checked-out connection: queryable, and must be released back to the pool. */
export type QueryableClient = {
  query<R>(sql: string, values?: unknown[]): Promise<{ rows: R[] }>;
  release(): Promise<void>;
};

export type PostgresConfig = {
  connectionString: string;
  /** Server-side cap on one statement. Default {@link POSTGRES_TIMEOUT_DEFAULTS.statementTimeoutMs}. */
  statementTimeoutMs?: number;
  /** Cap on establishing a new connection. Default {@link POSTGRES_TIMEOUT_DEFAULTS.connectTimeoutMs}. */
  connectTimeoutMs?: number;
  /** Cap on a session left idle inside a transaction. Default {@link POSTGRES_TIMEOUT_DEFAULTS.idleTransactionTimeoutMs}. */
  idleTransactionTimeoutMs?: number;
  /** Test seam: an already-built pool. Production always builds its own. */
  pool?: PoolLike;
};

/**
 * Timeouts, chosen against the real source size (~3.5M temperature rows as of
 * 2026-09-25) and a 20k-row page over a bounded, indexed range:
 *
 *   statement_timeout  180s — a page is an index range scan over at most the
 *       lag-guard window (~29k rows/day at the observed rate), so hundreds of
 *       seconds is orders of magnitude more than a healthy page needs, while a
 *       degraded plan (the failure that hung the ETL for four days) fails in
 *       minutes instead of never.
 *   query_timeout      statement_timeout + 15s — client-side backstop, set
 *       above the server-side value so the real Postgres error surfaces rather
 *       than a generic read timeout.
 *   connect            10s — the source is a LAN/VPN peer; a connect that has
 *       not completed in 10s is a broken path, not a slow one.
 *   idle in txn        30s — the ETL opens no transactions; a session stuck
 *       inside one is leaking a pooled connection and is reclaimed.
 */
export const POSTGRES_TIMEOUT_DEFAULTS = {
  statementTimeoutMs: 180_000,
  connectTimeoutMs: 10_000,
  idleTransactionTimeoutMs: 30_000,
} as const;

export function postgresPoolOptions(config: PostgresConfig) {
  const statementTimeout = config.statementTimeoutMs ?? POSTGRES_TIMEOUT_DEFAULTS.statementTimeoutMs;
  return {
    connectionString: config.connectionString,
    max: 4,
    ssl: { rejectUnauthorized: false },
    application_name: "laundrytwin-etl",
    statement_timeout: statementTimeout,
    query_timeout: statementTimeout + 15_000,
    connectionTimeoutMillis: config.connectTimeoutMs ?? POSTGRES_TIMEOUT_DEFAULTS.connectTimeoutMs,
    idle_in_transaction_session_timeout:
      config.idleTransactionTimeoutMs ?? POSTGRES_TIMEOUT_DEFAULTS.idleTransactionTimeoutMs,
    // The keyset is a bare timestamp compared against a source column; pin the
    // session to UTC so the comparison cannot shift with the server's timezone.
    options: "-c timezone=UTC",
  };
}

export function createPostgresSource(config: PostgresConfig): MachineUsageSource {
  const pool: PoolLike = config.pool ?? (new Pool(postgresPoolOptions(config)) as unknown as PoolLike);
  const statementTimeoutMs = config.statementTimeoutMs ?? POSTGRES_TIMEOUT_DEFAULTS.statementTimeoutMs;

  /**
   * Per-day row counts over an inclusive `from .. to` window, grouped by a day
   * derived from one timestamp column. Both audit helpers share this shape.
   *
   * `to` is widened by a day so the final day is INCLUDED — an off-by-one that
   * dropped it would report the newest business day as a gap, which is exactly
   * the day an auditor most needs to trust.
   *
   * The column name is interpolated, not bound, because a placeholder cannot
   * stand for an identifier. It is not caller input: both call sites pass a
   * literal from the pair below.
   */
  const auditUsageDays = async (
    column: "created_at" | "started_at",
    from: string,
    to: string
  ): Promise<Record<string, number>> => {
    const rows = await pool.query<{ day: string; rows: number }>(
      `SELECT to_char((${column})::date, 'YYYY-MM-DD') AS day, count(*)::int AS rows
         FROM machine_usage
        WHERE ${column} IS NOT NULL
          AND ${column} >= $1::date
          AND ${column} <  ($2::date + INTERVAL '1 day')
        GROUP BY 1`,
      [from, to]
    );
    return Object.fromEntries(rows.rows.map((r) => [r.day, r.rows]));
  };

  return {
    async listBranches() {
      const result = await pool.query<BranchRow>(
        `SELECT tenant_id::text AS tenant_id,
                id::text AS branch_id,
                name,
                timezone,
                status,
                updated_at
         FROM branch
         WHERE deleted_at IS NULL
         ORDER BY name`
      );
      return result.rows;
    },
    async listMachines() {
      const result = await pool.query<MachineRow>(
        `SELECT tenant_id::text AS tenant_id,
                branch_id::text AS branch_id,
                id::text AS machine_id,
                code,
                kind,
                modbus_address,
                status,
                updated_at,
                deleted_at
         FROM machine
         ORDER BY code`
      );
      return result.rows;
    },
    async listUsageSince(since, options = {}) {
      const limit = options.limit ?? 5000;
      // Strict tuple comparison on (created_at, id): an id ties rows that share
      // the same created_at, so fewer than `limit` rows with that timestamp are
      // never skipped on the next page.
      const result = await pool.query<UsageRow>(
        `SELECT tenant_id::text AS tenant_id,
                branch_id::text AS branch_id,
                machine_id::text AS machine_id,
                id::text AS usage_id,
                program_id,
                program_name,
                started_at,
                finished_at,
                duration_min,
                amount_satang,
                status,
                initiated_via,
                temp_level,
                attribution_state,
                attribution_reason,
                attribution_source,
                attribution_machine_session_id AS machine_session_id,
                source_event_id,
                created_at,
                updated_at
         FROM machine_usage
         WHERE (created_at, id) > ($1, $2)
         ORDER BY created_at ASC, id ASC
         LIMIT $3`,
        [since.at, since.id, limit]
      );
      return result.rows;
    },
    async listTemperatureSince(since, options = {}) {
      const limit = options.limit ?? 50000;
      // The temperature samples' `branch_id`/`machine_id` are EDGE-LOCAL labels
      // written verbatim from the signed wire payload (see iris-project
      // apps/cloud-sync/src/routes/ingest.ts::writeTemperatureSamples). They do
      // NOT reference machine.id/branch.id — e.g. machine_id is a Pi slot code
      // (`DRY-012` = dryer on modbus 12, see packages/contracts/src/edge-machine-id.ts)
      // and branch_id is a routing label like `BR-OTM-001`. The canonical join
      // the product itself uses (dashboard/usage-detail) resolves the machine by
      // slot code = kind + modulo(modbus, 100 via pad3) ONLY, then takes the
      // branch from the machine row. We mirror that here so temp rows carry the
      // canonical tenant/branch, never the edge label.
      //
      // Keyset on (occurred_at, seq, event_id) — see the file header for why
      // `occurred_at` and not `ingested_at`. The tuple is strict: bulks of
      // samples share one occurred_at, so a bare `occurred_at > x` would drop
      // the rows colliding on a batch boundary, and `event_id` is unique, so no
      // two rows can compare equal and the cursor always advances.
      //
      // `s.occurred_at >= $1` is implied by the row comparison, but is stated
      // as a bare range so the planner prunes partitions on the partition key
      // without reasoning about the OR expansion of the row comparison.
      // `s.occurred_at <= $4` is the lag guard the caller applies: it keeps the
      // read inside a bounded, prunable window and stops the cursor running past
      // rows that have not been ingested yet (a row whose occurred_at is older
      // than the cursor but which lands in the source afterwards would otherwise
      // be behind the keyset and never read).
      const bounded = options.until !== undefined;
      const result = await pool.query<TemperatureSampleRow>(
        `SELECT b.tenant_id::text AS tenant_id,
                b.id::text AS branch_id,
                m.id::text AS machine_id,
                s.event_id,
                s.seq::text AS seq,
                s.frame_seq::text AS frame_seq,
                s.occurred_at,
                s.ingested_at,
                s.temperature_f,
                s.phase
         FROM machine_temperature_sample s
         JOIN machine m
           ON m.kind = CASE WHEN s.machine_id LIKE 'DRY-%' THEN 'dryer' ELSE 'washer' END
          AND m.modbus_address = CAST(REGEXP_REPLACE(s.machine_id, '[A-Z-]+', '') AS integer)
         JOIN branch b ON b.id = m.branch_id
         WHERE s.occurred_at >= $1
           AND (s.occurred_at, s.seq, s.event_id) > ($1, $2, $3)${bounded ? "\n           AND s.occurred_at <= $4" : ""}
         ORDER BY s.occurred_at ASC, s.seq ASC, s.event_id ASC
         LIMIT $${bounded ? 5 : 4}`,
        bounded
          ? [since.at, since.seq, since.id, options.until, limit]
          : [since.at, since.seq, since.id, limit]
      );
      return result.rows;
    },
    async resolveTemperatureCursorFromIngested(legacy) {
      // One-off, on the first run after the 2026-09-29 fix. The only query in
      // this adapter that touches the unindexed `ingested_at`, and it is a
      // single row: the last row at or before the legacy position, whose
      // (occurred_at, seq, event_id) becomes the new boundary. Re-anchoring on
      // a row that was already loaded means no loaded row is read twice, and no
      // unloaded row is skipped.
      //
      // By construction this cannot use the index, so it is given a longer
      // server-side budget than a normal page. It runs once; if the source
      // outgrows even that, the run fails loudly and the operator can pin the
      // boundary with ETL_TEMPERATURE_SINCE_ISO instead.
      const migrateTimeoutMs = Math.max(statementTimeoutMs, 600_000);
      const client = pool.connect ? await pool.connect() : null;
      const run = async (executor: { query: PoolLike["query"] }) =>
        executor.query<{ occurred_at: Date; seq: string; event_id: string }>(
          `SELECT s.occurred_at,
                  s.seq::text AS seq,
                  s.event_id
           FROM machine_temperature_sample s
           WHERE (s.ingested_at, s.seq, s.event_id) <= ($1, $2, $3)
           ORDER BY s.ingested_at DESC, s.seq DESC, s.event_id DESC
           LIMIT 1`,
          [legacy.at, legacy.seq, legacy.id]
        );
      const setBudget = (ms: number) =>
        client!.query("SELECT set_config('statement_timeout', $1, false)", [String(ms)]);
      try {
        if (client) await setBudget(migrateTimeoutMs);
        const rows = await run(client ?? pool);
        const row = rows.rows[0];
        if (!row) return null;
        return { key: "occurred_at", at: row.occurred_at.toISOString(), seq: row.seq, id: row.event_id } as const;
      } finally {
        if (client) {
          // Put the per-page budget back before the connection returns to the
          // pool, or every later page would inherit the migration's 10 minutes.
          try {
            await setBudget(statementTimeoutMs);
          } catch {
            // A connection that cannot take the budget back is discarded on
            // release; the pool opens a fresh one with the pool default.
          }
          await client.release();
        }
      }
    },
    async firstUsageDay() {
      const rows = await pool.query<{ day: string | null }>(
        `SELECT to_char(min(created_at)::date, 'YYYY-MM-DD') AS day FROM machine_usage`
      );
      return rows.rows[0]?.day ?? null;
    },
    auditUsageDaysByCreatedAt(from, to) {
      return auditUsageDays("created_at", from, to);
    },
    auditUsageDaysByStartedAt(from, to) {
      return auditUsageDays("started_at", from, to);
    },
    async close() {
      await pool.end();
    },
  };
}