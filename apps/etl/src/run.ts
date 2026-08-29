// ETL orchestration: extract -> transform -> load, dataset by dataset, with
// incremental watermark advancement. Zero-dependency on the surrounding apps;
// source and warehouse are injected so the whole flow is testable.
//
// Idempotency model:
//   - Primary: incremental whose watermark (usage.created_at,
//     temperature.ingested_at) only advances AFTER a batch commits. A retry of
//     a failed batch re-reads the same window.
//   - Backup: fact tables are ReplacingMergeTree keyed by source_event_id, so
//     even if an overlapping row is re-inserted it converges to one row.
//
// Dims are loaded before facts each run (full resync) so joins never see a
// missing branch/machine name.

import type { ClickHouseClient } from "./clickhouse.js";
import type { MachineUsageSource } from "./postgres.js";
import { CREATE_TABLES } from "./schema.js";
import {
  toDimBranch,
  toDimMachine,
  toFactMachineUsage,
  toFactTemperatureSample,
  type DimMachineRow,
} from "./transform.js";
import type { TemperatureCursor, UsageCursor, Watermark } from "./watermark.js";

/** Structural surface runEtl needs from the watermark store. */
export type WatermarkLike = {
  load(): Watermark;
  save(wm: Watermark): void;
};

export type EtlResult = {
  branchesLoaded: number;
  machinesLoaded: number;
  usagesLoaded: number;
  temperaturesLoaded: number;
};

export type RunOptions = {
  source: MachineUsageSource;
  warehouse: ClickHouseClient;
  watermarks: WatermarkLike;
  usageBatchSize?: number;
  temperatureBatchSize?: number;
  sinceFallbackDays?: number;
};

export async function runEtl(options: RunOptions): Promise<EtlResult> {
  const { source, warehouse, watermarks } = options;
  const usageBatchSize = options.usageBatchSize ?? 2000;
  const temperatureBatchSize = options.temperatureBatchSize ?? 20000;

  for (const ddl of CREATE_TABLES) await warehouse.execute(ddl);

  const now = new Date();
  const extractedAt = now;

  // 1. Dims (full resync each run).
  const branches = await source.listBranches();
  const dimBranches = branches.map((b) => toDimBranch(b, extractedAt));
  if (dimBranches.length > 0) await warehouse.insert("dim_branch", dimBranches);

  const machines = (await source.listMachines())
    .map((m) => toDimMachine(m, extractedAt))
    .filter((r): r is DimMachineRow => r !== null);
  if (machines.length > 0) await warehouse.insert("dim_machine", machines);

  const wm = watermarks.load();

  // 2. Machine usage facts. Strict composite cursors so an interrupted batch
  //    resumes exactly where it stopped (no re-read, no skipped boundary rows).
  const usageSince: UsageCursor = wm.usage ?? startUsageCursor(now, options.sinceFallbackDays ?? 0);
  const usagesLoaded = await loadUsage({ source, warehouse }, usageSince, usageBatchSize, watermarks, extractedAt);

  // 3. Temperature facts.
  const temperatureSince: TemperatureCursor =
    wm.temperature ?? startTemperatureCursor(now, options.sinceFallbackDays ?? 0);
  const temperaturesLoaded = await loadTemperature(
    { source, warehouse },
    temperatureSince,
    temperatureBatchSize,
    watermarks,
    extractedAt
  );

  return { branchesLoaded: dimBranches.length, machinesLoaded: machines.length, usagesLoaded, temperaturesLoaded };
}

async function loadUsage(
  ctx: { source: MachineUsageSource; warehouse: ClickHouseClient },
  since: UsageCursor,
  batchSize: number,
  watermarks: WatermarkLike,
  extractedAt: Date
): Promise<number> {
  let total = 0;
  let cursor = since;
  for (;;) {
    const rows = await ctx.source.listUsageSince(cursor, { limit: batchSize });
    if (rows.length === 0) break;
    const facts = rows.map((r) => toFactMachineUsage(r, extractedAt));
    await ctx.warehouse.insert("fact_machine_usage", facts);
    total += facts.length;
    const last = rows[rows.length - 1];
    cursor = { at: last.created_at.toISOString(), id: last.usage_id };
    const wm = watermarks.load();
    wm.usage = cursor;
    watermarks.save(wm);
    if (rows.length < batchSize) break;
  }
  return total;
}

async function loadTemperature(
  ctx: { source: MachineUsageSource; warehouse: ClickHouseClient },
  since: TemperatureCursor,
  batchSize: number,
  watermarks: WatermarkLike,
  extractedAt: Date
): Promise<number> {
  let total = 0;
  let cursor = since;
  for (;;) {
    const rows = await ctx.source.listTemperatureSince(cursor, { limit: batchSize });
    if (rows.length === 0) break;
    const facts = rows.map((r) => toFactTemperatureSample(r, extractedAt));
    await ctx.warehouse.insert("fact_temperature_sample", facts);
    total += facts.length;
    const last = rows[rows.length - 1];
    cursor = { at: last.ingested_at.toISOString(), seq: last.seq, id: last.event_id };
    const wm = watermarks.load();
    wm.temperature = cursor;
    watermarks.save(wm);
    if (rows.length < batchSize) break;
  }
  return total;
}

function earlier(fallbackDays: number, now: Date): string {
  return new Date(now.getTime() - fallbackDays * 24 * 60 * 60 * 1000).toISOString();
}

const USAGE_ZERO_ID = "00000000-0000-0000-0000-000000000000";

function startUsageCursor(now: Date, fallbackDays: number): UsageCursor {
  return { at: earlier(fallbackDays, now), id: USAGE_ZERO_ID };
}

function startTemperatureCursor(now: Date, fallbackDays: number): TemperatureCursor {
  return { at: earlier(fallbackDays, now), seq: "0", id: "" };
}
