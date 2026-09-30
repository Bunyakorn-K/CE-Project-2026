// ETL orchestration: extract -> transform -> load, dataset by dataset, with
// incremental watermark advancement. Zero-dependency on the surrounding apps;
// source and warehouse are injected so the whole flow is testable.
//
// Idempotency model:
//   - Primary: incremental whose watermark (usage.created_at,
//     temperature.occurred_at) only advances AFTER a batch commits. A retry of
//     a failed batch re-reads the same window.
//   - Backup: every fact table is a ReplacingMergeTree versioned by its source
//     freshness column (fact_machine_usage by source_event_id,
//     fact_temperature_sample by extracted_at, fact_weather_sample by
//     timestamp, fact_gas_pressure_sample by ingested_at), so a re-read
//     converges to one row instead of inserting a second copy.
//
//     The temperature table was a plain MergeTree until 2026-09-30 and had no
//     backup layer at all — the watermark was the only thing standing between a
//     re-read and a permanent duplicate. It failed: 1,503,920 duplicate sort
//     keys, one sample written 82 times. The watermark must still advance only
//     after the insert commits; the table engine is what makes the re-read
//     harmless when it does not.
//
// Diagnosability (2026-09-29): every phase logs start/finish with its elapsed
// time and each temperature/usage batch logs its own progress, and a phase that
// exceeds its budget fails the run loudly. The previous build logged only the
// final summary, so a four-day hang produced no signal at all.
//
// Dims are loaded before facts each run (full resync) so joins never see a
// missing branch/machine name.

import type { ClickHouseClient } from "./clickhouse.js";
import { nowUtc } from "./datetime.js";
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

/**
 * How far behind wall-clock the temperature read stops. A row is written to
 * IRIS with both `occurred_at` (device event time) and `ingested_at` (write
 * time), so a row whose event time is older than the current cursor can still
 * land in the source afterwards; on an `ingested_at` keyset that could not
 * happen, on an `occurred_at` keyset it would put the row permanently behind the
 * cursor. Stopping this far short of now() leaves room for that lag. The real
 * worst-case occurred_at -> ingested_at delay in IRIS has never been measured
 * from this repository, so treat 24h as a deliberately generous default rather
 * than a measured one, and raise it if a source is seen to buffer longer.
 */
export const TEMPERATURE_LAG_DEFAULT_MS = 24 * 60 * 60 * 1000;

/**
 * Per-phase budget. A phase that exceeds it fails the run instead of hanging
 * silently. The source statement timeout and the warehouse request budget are
 * what actually release the process; this is the loud signal on top of them.
 */
export const PHASE_BUDGET_DEFAULT_MS = 15 * 60 * 1000;

export type RunOptions = {
  source: MachineUsageSource;
  warehouse: ClickHouseClient;
  watermarks: WatermarkLike;
  usageBatchSize?: number;
  temperatureBatchSize?: number;
  sinceFallbackDays?: number;
  /** Clock injection point for tests; defaults to the UTC wall clock. */
  now?: Date;
  /** Upper bound for the temperature read. Default {@link TEMPERATURE_LAG_DEFAULT_MS}. */
  temperatureLagMs?: number;
  /** Per-phase budget in ms; 0 disables it. Default {@link PHASE_BUDGET_DEFAULT_MS}. */
  phaseTimeoutMs?: number;
  /** Operator-pinned temperature start (ISO-8601); wins over any stored cursor. */
  temperatureSinceIso?: string | null;
  /** Log sink; defaults to stdout so `docker logs` carries the phase trail. */
  log?: (line: string) => void;
};

export async function runEtl(options: RunOptions): Promise<EtlResult> {
  const { source, warehouse, watermarks } = options;
  const usageBatchSize = options.usageBatchSize ?? 2000;
  const temperatureBatchSize = options.temperatureBatchSize ?? 20000;
  const temperatureLagMs = options.temperatureLagMs ?? TEMPERATURE_LAG_DEFAULT_MS;
  const phase = new PhaseRunner({
    log: options.log ?? ((line) => console.log(line)),
    budgetMs: options.phaseTimeoutMs ?? PHASE_BUDGET_DEFAULT_MS,
  });

  await phase.run("schema", async () => {
    for (const ddl of CREATE_TABLES) await warehouse.execute(ddl);
  });

  const now = options.now ?? nowUtc();
  const extractedAt = now;
  const temperatureUntil = new Date(now.getTime() - temperatureLagMs);

  // 1. Dims (full resync each run).
  const branches = await phase.run("dim-branch", () => source.listBranches());
  const dimBranches = branches.map((b) => toDimBranch(b, extractedAt));
  if (dimBranches.length > 0) await phase.run("dim-branch-insert", () => warehouse.insert("dim_branch", dimBranches));

  const machines = (
    await phase.run("dim-machine", () => source.listMachines())
  )
    .map((m) => toDimMachine(m, extractedAt))
    .filter((r): r is DimMachineRow => r !== null);
  if (machines.length > 0) await phase.run("dim-machine-insert", () => warehouse.insert("dim_machine", machines));

  const wm = watermarks.load();

  // 2. Machine usage facts. Strict composite cursors so an interrupted batch
  //    resumes exactly where it stopped (no re-read, no skipped boundary rows).
  const usageSince: UsageCursor = wm.usage ?? startUsageCursor(now, options.sinceFallbackDays ?? 0);
  const usagesLoaded = await phase.run("usage", () =>
    loadUsage({ source, warehouse, log: phase.log }, usageSince, usageBatchSize, watermarks, extractedAt)
  );

  // 3. Temperature facts. Keyed on occurred_at (indexed + partition key in
  //    IRIS) and bounded by the lag guard, unlike the ingested_at keyset that
  //    full-scanned the table and hung the run on 2026-09-25.
  const temperatureSince = await resolveTemperatureSince({
    source,
    watermarks,
    wm,
    now,
    temperatureUntil,
    fallbackDays: options.sinceFallbackDays ?? 0,
    sinceIso: options.temperatureSinceIso ?? null,
    log: phase.log,
  });
  if (new Date(temperatureSince.at) > temperatureUntil) {
    phase.log(
      `ETL warning: temperature cursor ${temperatureSince.at} is ahead of the lag guard ` +
        `${temperatureUntil.toISOString()}; the read stays idle until the clock catches up`
    );
  }
  const temperaturesLoaded = await phase.run("temperature", () =>
    loadTemperature(
      { source, warehouse, log: phase.log },
      temperatureSince,
      temperatureBatchSize,
      watermarks,
      extractedAt,
      temperatureUntil
    )
  );

  return { branchesLoaded: dimBranches.length, machinesLoaded: machines.length, usagesLoaded, temperaturesLoaded };
}

/** Logs every phase and fails the run when one overruns its budget. */
class PhaseRunner {
  constructor(
    private readonly opts: { log: (line: string) => void; budgetMs: number }
  ) {}

  get log(): (line: string) => void {
    return this.opts.log;
  }

  async run<T>(name: string, work: () => Promise<T>): Promise<T> {
    this.opts.log(`ETL phase=${name} status=start`);
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      if (this.opts.budgetMs <= 0) return;
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `ETL phase=${name} exceeded its budget of ${this.opts.budgetMs} ms ` +
                `(elapsed ${Date.now() - startedAt} ms) — the phase did not finish`
            )
          ),
        this.opts.budgetMs
      );
      timer.unref?.();
    });
    try {
      const result = await Promise.race([work(), budget]);
      this.opts.log(`ETL phase=${name} status=ok elapsed_ms=${Date.now() - startedAt}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.log(`ETL phase=${name} status=failed elapsed_ms=${Date.now() - startedAt} error=${message}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

async function resolveTemperatureSince(ctx: {
  source: MachineUsageSource;
  watermarks: WatermarkLike;
  wm: Watermark;
  now: Date;
  temperatureUntil: Date;
  fallbackDays: number;
  sinceIso: string | null;
  log: (line: string) => void;
}): Promise<TemperatureCursor> {
  if (ctx.wm.temperature) return ctx.wm.temperature;
  if (ctx.sinceIso) {
    const pinned = new Date(ctx.sinceIso);
    if (Number.isNaN(pinned.getTime())) {
      throw new Error(`ETL_TEMPERATURE_SINCE_ISO is not a valid ISO-8601 instant: ${ctx.sinceIso}`);
    }
    ctx.log(
      `ETL temperature=start source=ETL_TEMPERATURE_SINCE_ISO at=${pinned.toISOString()} ` +
        "note=rows before this instant are NOT re-read"
    );
    return { key: "occurred_at", at: pinned.toISOString(), seq: "0", id: "" };
  }
  if (ctx.wm.temperatureIngestedCursor) {
    const legacy = ctx.wm.temperatureIngestedCursor;
    ctx.log(
      `ETL temperature=cursor-migrate from=ingested_at at=${legacy.at} ` +
        "reason=ingested_at is unindexed in IRIS and gets no partition pruning"
    );
    const migrated = await ctx.source.resolveTemperatureCursorFromIngested(legacy);
    if (migrated) {
      ctx.log(`ETL temperature=cursor-migrated to=occurred_at at=${migrated.at} seq=${migrated.seq}`);
      // Persist the re-anchor immediately: it is a boundary of rows already in
      // the warehouse, so nothing is re-read if this run then fails.
      const wm = ctx.watermarks.load();
      wm.temperature = migrated;
      wm.temperatureIngestedCursor = null;
      ctx.watermarks.save(wm);
      return migrated;
    }
    ctx.log(
      "ETL temperature=cursor-migrate result=empty; the source has no row at or before the legacy " +
        "cursor, so the fallback window applies"
    );
  }
  return startTemperatureCursor(ctx.now, ctx.fallbackDays);
}

async function loadUsage(
  ctx: { source: MachineUsageSource; warehouse: ClickHouseClient; log: (line: string) => void },
  since: UsageCursor,
  batchSize: number,
  watermarks: WatermarkLike,
  extractedAt: Date
): Promise<number> {
  let total = 0;
  let cursor = since;
  const startedAt = Date.now();
  for (let batch = 1; ; batch += 1) {
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
    ctx.log(
      `ETL phase=usage batch=${batch} rows=${rows.length} total_rows=${total} elapsed_ms=${Date.now() - startedAt}`
    );
    if (rows.length < batchSize) break;
  }
  return total;
}

async function loadTemperature(
  ctx: { source: MachineUsageSource; warehouse: ClickHouseClient; log: (line: string) => void },
  since: TemperatureCursor,
  batchSize: number,
  watermarks: WatermarkLike,
  extractedAt: Date,
  until: Date
): Promise<number> {
  let total = 0;
  let cursor = since;
  const startedAt = Date.now();
  for (let batch = 1; ; batch += 1) {
    const rows = await ctx.source.listTemperatureSince(cursor, { limit: batchSize, until });
    if (rows.length === 0) break;
    const facts = rows.map((r) => toFactTemperatureSample(r, extractedAt));
    await ctx.warehouse.insert("fact_temperature_sample", facts);
    total += facts.length;
    const last = rows[rows.length - 1];
    // `at` is occurred_at, the column the keyset and the index are bound to.
    cursor = { key: "occurred_at", at: last.occurred_at.toISOString(), seq: last.seq, id: last.event_id };
    const wm = watermarks.load();
    wm.temperature = cursor;
    watermarks.save(wm);
    ctx.log(
      `ETL phase=temperature batch=${batch} rows=${rows.length} total_rows=${total} ` +
        `cursor_at=${cursor.at} until=${until.toISOString()} elapsed_ms=${Date.now() - startedAt}`
    );
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
  return { key: "occurred_at", at: earlier(fallbackDays, now), seq: "0", id: "" };
}
