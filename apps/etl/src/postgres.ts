// Postgres source adapter. Reads durable machine-usage data from the IRIS
// `iris_project` database on the VPS. All queries are parameterized; rows are
// typed at the boundary and transformed in transform.ts (no raw values leak
// into SQL text).

import pg from "pg";
import type { TemperatureCursor, UsageCursor } from "./watermark.js";

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
  listTemperatureSince(since: TemperatureCursor, options?: { limit?: number }): Promise<TemperatureSampleRow[]>;
  close(): Promise<void>;
};

export type PostgresConfig = {
  connectionString: string;
  fetchImpl?: never;
};

export function createPostgresSource(config: PostgresConfig): MachineUsageSource {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: 4,
    ssl: { rejectUnauthorized: false },
  });

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
      // Strict tuple comparison on (ingested_at, seq, event_id): bulks of samples
      // share one ingested_at, so a bare `ingested_at > x` would silently drop the
      // rows colliding on the batch boundary. event_id is unique, so the tuple is
      // strict.
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
         WHERE (s.ingested_at, s.seq, s.event_id) > ($1, $2, $3)
         ORDER BY s.ingested_at ASC, s.seq ASC, s.event_id ASC
         LIMIT $4`,
        [since.at, since.seq, since.id, limit]
      );
      return result.rows;
    },
    async close() {
      await pool.end();
    },
  };
}