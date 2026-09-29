import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "../src/clickhouse.js";
import type {
  BranchRow,
  MachineRow,
  MachineUsageSource,
  TemperatureSampleRow,
  UsageRow,
} from "../src/postgres.js";
import { runEtl } from "../src/run.js";
import type {
  IngestedTemperatureCursor,
  TemperatureCursor,
  UsageCursor,
  Watermark,
  WatermarkStore,
} from "../src/watermark.js";

function fakeWarehouse(log: Array<{ op: string; args?: unknown }>): ClickHouseClient {
  return {
    async execute(sql: string) {
      log.push({ op: "execute", args: sql });
      return "";
    },
    async query<T>(): Promise<T[]> {
      return [] as T[];
    },
    async insert<T>(table: string, rows: T[]) {
      log.push({ op: "insert", args: { table, rows } });
    },
  } as unknown as ClickHouseClient;
}

// Pinned run clock, threaded into every runEtl() call. Fixture rows are built as
// offsets from this same instant, so the relative `now - 30 days` fallback
// window always contains them regardless of when the suite actually runs.
const NOW = new Date("2026-08-29T08:00:00.000Z");
// Fixture "hour N" of 2026-08-29, expressed as an offset from the pinned clock.
const atHour = (hour: number) => new Date(NOW.getTime() - (8 - hour) * 60 * 60 * 1000);

function usageRow(id: string, createdHour: number): UsageRow {
  return {
    tenant_id: "ten1",
    branch_id: "br1",
    machine_id: "m1",
    usage_id: `usage-${id}`,
    program_id: 2,
    program_name: "standard",
    started_at: atHour(createdHour),
    finished_at: null,
    duration_min: 40,
    amount_satang: 40000,
    status: "finished",
    initiated_via: "liff",
    temp_level: null,
    attribution_state: "resolved",
    attribution_reason: "exact_edge_lifecycle",
    attribution_source: null,
    machine_session_id: null,
    source_event_id: id,
    created_at: atHour(createdHour),
    updated_at: new Date(atHour(createdHour).getTime() + 5 * 60 * 1000),
  };
}

function tempRow(
  id: string,
  hour: number,
  opts: { seq?: string; occurredOffsetMs?: number } = {}
): TemperatureSampleRow {
  const occurred = atHour(hour);
  return {
    tenant_id: "ten1",
    branch_id: "br1",
    machine_id: "m1",
    event_id: id,
    seq: opts.seq ?? "1",
    frame_seq: null,
    occurred_at: new Date(occurred.getTime() + (opts.occurredOffsetMs ?? 0)),
    // Ingestion is always later than the event, as IRIS writes it.
    ingested_at: new Date(occurred.getTime() + 4_000),
    temperature_f: 92,
    phase: "wash",
  };
}

// Mirrors the keyset the Postgres adapter now uses:
//   WHERE s.occurred_at >= $1 AND (s.occurred_at, s.seq, s.event_id) > ($1,$2,$3)
//     AND s.occurred_at <= $4
//   ORDER BY s.occurred_at, s.seq, s.event_id
type TempTuple = [number, bigint, string];

function tempTuple(row: TemperatureSampleRow): TempTuple {
  return [row.occurred_at.getTime(), BigInt(row.seq), row.event_id];
}

function compareTuples(a: TempTuple, b: TempTuple): number {
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

function fakeSource(
  rows: { usages: UsageRow[]; temps: TemperatureSampleRow[] },
  hooks: { hang?: boolean } = {}
): MachineUsageSource & { migrated: IngestedTemperatureCursor[] } {
  const migrated: IngestedTemperatureCursor[] = [];
  const source = {
    migrated,
    async listBranches(): Promise<BranchRow[]> {
      return [
        {
          tenant_id: "ten1",
          branch_id: "br1",
          name: "Otteri",
          timezone: "Asia/Bangkok",
          status: "active",
          updated_at: new Date("2026-08-29T00:00:00.000Z"),
        },
      ];
    },
    async listMachines(): Promise<MachineRow[]> {
      return [
        {
          tenant_id: "ten1",
          branch_id: "br1",
          machine_id: "m1",
          code: "W1",
          kind: "washer",
          modbus_address: 1,
          status: "active",
          updated_at: new Date("2026-08-29T00:00:00.000Z"),
          deleted_at: null,
        },
      ];
    },
    async listUsageSince(since: UsageCursor, options = { limit: 5000 }) {
      return rows.usages.filter((r) => r.created_at > new Date(since.at)).slice(0, options.limit ?? 5000);
    },
    async listTemperatureSince(
      since: TemperatureCursor,
      options: { limit?: number; until?: Date } = { limit: 50000 }
    ) {
      if (hooks.hang) await new Promise(() => {});
      const cursor: TempTuple = [new Date(since.at).getTime(), BigInt(since.seq), since.id];
      return rows.temps
        .filter((r) => compareTuples(tempTuple(r), cursor) > 0)
        .filter((r) => (options.until ? r.occurred_at <= options.until : true))
        .sort((a, b) => compareTuples(tempTuple(a), tempTuple(b)))
        .slice(0, options.limit ?? 50000);
    },
    async resolveTemperatureCursorFromIngested(legacy: IngestedTemperatureCursor) {
      migrated.push(legacy);
      return {
        key: "occurred_at" as const,
        at: "2026-08-29T01:00:00.000Z",
        seq: "42",
        id: "t-anchor",
      };
    },
    async close() {},
  };
  return source as unknown as MachineUsageSource & { migrated: IngestedTemperatureCursor[] };
}

function fakeWatermarks(): ReturnType<typeof makeWatermarkStore> {
  const file = new Map<string, string>();
  const saved: Array<Watermark> = [];
  return makeWatermarkStore(file, saved);
}

function makeWatermarkStore(file: Map<string, string>, saved: Array<Watermark>) {
  const empty: Watermark = {
    usageCreatedAt: null,
    temperatureIngestedAt: null,
    usage: null,
    temperature: null,
    temperatureIngestedCursor: null,
  };
  return {
    load(): Watermark {
      const raw = file.get("v");
      if (!raw) return empty;
      return JSON.parse(raw) as Watermark;
    },
    save(wm: Watermark) {
      file.set("v", JSON.stringify(wm));
      saved.push({ ...wm });
    },
    get saved() {
      return saved;
    },
  };
}

describe("runEtl", () => {
  it("loads dims then facts, advancing no watermark when sources are empty", async () => {
    const log: Array<{ op: string; args?: unknown }> = [];
    const warehouse = fakeWarehouse(log);
    const source = fakeSource({ usages: [], temps: [] });
    const watermarks = fakeWatermarks();

    const result = await runEtl({
      source,
      warehouse,
      watermarks,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });

    expect(result).toEqual({ branchesLoaded: 1, machinesLoaded: 1, usagesLoaded: 0, temperaturesLoaded: 0 });
    const inserts = log.filter((l) => l.op === "insert");
    expect(inserts.map((i) => (i.args as { table: string }).table)).toEqual([
      "dim_branch",
      "dim_machine",
    ]);
    expect(log.some((l) => l.op === "insert")).toBe(true);
    expect(watermarks.load()).toEqual({
      usageCreatedAt: null,
      temperatureIngestedAt: null,
      usage: null,
      temperature: null,
      temperatureIngestedCursor: null,
    });
  });

  it("loads all usage and temperature batches and advances watermarks to the last row", async () => {
    const log: Array<{ op: string; args?: unknown }> = [];
    const warehouse = fakeWarehouse(log);
    const usages = [usageRow("u1", 1), usageRow("u2", 2)];
    const temps = [tempRow("t1", 1), tempRow("t2", 2)];
    const source = fakeSource({ usages, temps });
    const watermarks = fakeWatermarks();

    const result = await runEtl({
      source,
      warehouse,
      watermarks,
      usageBatchSize: 5,
      temperatureBatchSize: 5,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });

    expect(result.usagesLoaded).toBe(2);
    expect(result.temperaturesLoaded).toBe(2);
    const inserts = log.filter((l) => l.op === "insert").map((i) => (i.args as { table: string }).table);
    expect(inserts).toContain("fact_machine_usage");
    expect(inserts).toContain("fact_temperature_sample");
    const wm = watermarks.load();
    expect(wm.usage?.at).toBe("2026-08-29T02:00:00.000Z");
    expect(wm.temperature?.at).toBe("2026-08-29T02:00:00.000Z");
    expect(wm.usage?.id).toBe("usage-u2");
    expect(wm.temperature?.id).toBe("t2");
    // The persisted cursor records which source column `at` is bound to.
    expect(wm.temperature?.key).toBe("occurred_at");
  });

  it("is idempotent on re-run: no new inserts and watermarks stay put", async () => {
    const log1: Array<{ op: string; args?: unknown }> = [];
    const log2: Array<{ op: string; args?: unknown }> = [];
    const usages = [usageRow("u1", 1)];
    const temps = [tempRow("t1", 1)];
    const watermarks1 = fakeWatermarks();
    await runEtl({
      source: fakeSource({ usages, temps }),
      warehouse: fakeWarehouse(log1),
      watermarks: watermarks1,
      usageBatchSize: 5,
      temperatureBatchSize: 5,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });

    // Second run: source returns nothing new because the fake filters by watermark.
    const watermarks2 = fakeWatermarks();
    watermarks2.save({ ...watermarks1.load() });
    const result = await runEtl({
      source: fakeSource({ usages, temps }),
      warehouse: fakeWarehouse(log2),
      watermarks: watermarks2,
      usageBatchSize: 5,
      temperatureBatchSize: 5,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });

    expect(result.usagesLoaded).toBe(0);
    expect(result.temperaturesLoaded).toBe(0);
    const factInserts2 = log2.filter(
      (l) => l.op === "insert" && (l.args as { table: string }).table.startsWith("fact_")
    );
    expect(factInserts2).toHaveLength(0);
    const wm = watermarks2.load();
    expect(wm.usage?.at).toBe("2026-08-29T01:00:00.000Z");
    expect(wm.usage?.id).toBe("usage-u1");
  });

  it("batches usage by limit and advances watermark per batch", async () => {
    const usages = [usageRow("u1", 1), usageRow("u2", 2), usageRow("u3", 3), usageRow("u4", 4)];
    const source = fakeSource({ usages, temps: [] });
    const watermarks = fakeWatermarks();
    const log: Array<{ op: string; args?: unknown }> = [];
    const result = await runEtl({
      source,
      warehouse: fakeWarehouse(log),
      watermarks,
      usageBatchSize: 2,
      temperatureBatchSize: 5,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });
    expect(result.usagesLoaded).toBe(4);
    const usageInserts = log.filter(
      (l) => l.op === "insert" && (l.args as { table: string }).table === "fact_machine_usage"
    );
    expect(usageInserts).toHaveLength(2);
    const wm = watermarks.load();
    expect(wm.usage?.at).toBe("2026-08-29T04:00:00.000Z");
    expect(wm.usage?.id).toBe("usage-u4");
  });
});

describe("runEtl temperature keyset", () => {
  it("delivers every sample exactly once when occurred_at and seq collide on page boundaries", async () => {
    // The failure this guards: a keyset that cannot distinguish rows sharing a
    // timestamp would stall on the same page or skip the rest of the tie group.
    const temps: TemperatureSampleRow[] = [];
    for (let i = 0; i < 6; i += 1) {
      temps.push(tempRow(`bulk-${i}`, 3, { seq: String(i) }));
    }
    // Same occurred_at as the bulk above, but ingested much later: the ordering
    // key is occurred_at, so these sort inside the tie group by seq then id.
    temps.push(tempRow("late-a", 3, { seq: "1", occurredOffsetMs: 1 }));
    temps.push(tempRow("late-b", 3, { seq: "1", occurredOffsetMs: 1 }));
    temps.push(tempRow("next-hour", 4));

    const log: Array<{ op: string; args?: unknown }> = [];
    const watermarks = fakeWatermarks();
    const result = await runEtl({
      source: fakeSource({ usages: [], temps }),
      warehouse: fakeWarehouse(log),
      watermarks,
      usageBatchSize: 100,
      temperatureBatchSize: 2,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });

    expect(result.temperaturesLoaded).toBe(temps.length);
    const delivered = log
      .filter((l) => l.op === "insert" && (l.args as { table: string }).table === "fact_temperature_sample")
      .flatMap((l) => (l.args as { rows: Array<{ event_id: string }> }).rows)
      .map((r) => r.event_id);
    expect(delivered).toEqual(temps.map((t) => t.event_id));
    expect(new Set(delivered).size).toBe(temps.length);
    // Final cursor is the maximum tuple, so the next run resumes without a gap.
    const last = temps.reduce((a, b) => (compareTuples(tempTuple(a), tempTuple(b)) >= 0 ? a : b));
    expect(watermarks.load().temperature).toEqual({
      key: "occurred_at",
      at: last.occurred_at.toISOString(),
      seq: last.seq,
      id: last.event_id,
    });
  });

  it("stops at the lag guard so a row that is not ingested yet is not read early", async () => {
    const temps = [tempRow("t1", 1), tempRow("t2", 5), tempRow("t3", 7)];
    const watermarks = fakeWatermarks();
    const log: Array<{ op: string; args?: unknown }> = [];
    const result = await runEtl({
      source: fakeSource({ usages: [], temps }),
      warehouse: fakeWarehouse(log),
      watermarks,
      usageBatchSize: 100,
      temperatureBatchSize: 100,
      sinceFallbackDays: 30,
      now: NOW,
      // 4h of lag: the guard sits at 04:00, so only t1 (01:00) is readable.
      temperatureLagMs: 4 * 60 * 60 * 1000,
    });

    expect(result.temperaturesLoaded).toBe(1);
    expect(watermarks.load().temperature?.id).toBe("t1");
    expect(watermarks.load().temperature?.at).toBe("2026-08-29T01:00:00.000Z");
  });
});

describe("runEtl watermark migration", () => {
  it("re-anchors a legacy ingested_at cursor instead of reinterpreting it", async () => {
    const watermarks = fakeWatermarks();
    watermarks.save({
      usageCreatedAt: null,
      temperatureIngestedAt: null,
      usage: null,
      temperature: null,
      temperatureIngestedCursor: { at: "2026-09-25T12:00:00.000Z", seq: "9", id: "evt-9" },
    });
    const source = fakeSource({ usages: [], temps: [tempRow("already-loaded", 0)] });

    const result = await runEtl({
      source,
      warehouse: fakeWarehouse([]),
      watermarks,
      usageBatchSize: 100,
      temperatureBatchSize: 100,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
    });

    expect(source.migrated).toEqual([{ at: "2026-09-25T12:00:00.000Z", seq: "9", id: "evt-9" }]);
    // The row sorts before the migrated anchor (00:00 < 01:00), so it is not
    // re-read: the migration must not resurrect already-loaded rows.
    expect(result.temperaturesLoaded).toBe(0);
    const wm = watermarks.load();
    expect(wm.temperature).toEqual({
      key: "occurred_at",
      at: "2026-08-29T01:00:00.000Z",
      seq: "42",
      id: "t-anchor",
    });
    expect(wm.temperatureIngestedCursor).toBeNull();
  });

  it("prefers an explicit ETL_TEMPERATURE_SINCE_ISO over the legacy re-anchor", async () => {
    const watermarks = fakeWatermarks();
    watermarks.save({
      usageCreatedAt: null,
      temperatureIngestedAt: null,
      usage: null,
      temperature: null,
      temperatureIngestedCursor: { at: "2026-09-25T12:00:00.000Z", seq: "9", id: "evt-9" },
    });
    const source = fakeSource({ usages: [], temps: [tempRow("t1", 1)] });

    await runEtl({
      source,
      warehouse: fakeWarehouse([]),
      watermarks,
      usageBatchSize: 100,
      temperatureBatchSize: 100,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
      temperatureSinceIso: "2026-08-29T00:30:00.000Z",
    });

    expect(source.migrated).toEqual([]);
    expect(watermarks.load().temperature?.at).toBe("2026-08-29T01:00:00.000Z");
  });

  it("rejects an unparseable ETL_TEMPERATURE_SINCE_ISO instead of falling back silently", async () => {
    await expect(
      runEtl({
        source: fakeSource({ usages: [], temps: [] }),
        warehouse: fakeWarehouse([]),
        watermarks: fakeWatermarks(),
        now: NOW,
        temperatureLagMs: 0,
        temperatureSinceIso: "yesterday",
      })
    ).rejects.toThrow(/ETL_TEMPERATURE_SINCE_ISO/);
  });
});

describe("runEtl diagnosability", () => {
  it("logs every phase and per-batch progress so a hang names itself in docker logs", async () => {
    const lines: string[] = [];
    const temps = [tempRow("t1", 1), tempRow("t2", 2), tempRow("t3", 3)];
    await runEtl({
      source: fakeSource({ usages: [usageRow("u1", 1)], temps }),
      warehouse: fakeWarehouse([]),
      watermarks: fakeWatermarks(),
      usageBatchSize: 1,
      temperatureBatchSize: 1,
      sinceFallbackDays: 30,
      now: NOW,
      temperatureLagMs: 0,
      log: (line) => lines.push(line),
    });

    expect(lines).toContain("ETL phase=schema status=start");
    expect(lines).toContain("ETL phase=dim-branch status=start");
    expect(lines).toContain("ETL phase=usage status=start");
    expect(lines).toContain("ETL phase=temperature status=start");
    expect(lines.filter((l) => l.includes("phase=temperature status=ok"))).toHaveLength(1);
    // Per-batch progress: a stall inside a phase is visible as the last line.
    expect(lines.filter((l) => l.includes("phase=temperature") && l.includes("batch=1"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("phase=temperature") && l.includes("batch=3"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("phase=usage") && l.includes("rows=1"))).not.toHaveLength(0);
  });

  it("fails loudly when a phase exceeds its budget instead of hanging forever", async () => {
    const lines: string[] = [];
    await expect(
      runEtl({
        source: fakeSource({ usages: [], temps: [] }, { hang: true }),
        warehouse: fakeWarehouse([]),
        watermarks: fakeWatermarks(),
        sinceFallbackDays: 30,
        now: NOW,
        temperatureLagMs: 0,
        phaseTimeoutMs: 25,
        log: (line) => lines.push(line),
      })
    ).rejects.toThrow(/phase=temperature .*budget/i);
    expect(lines).toContain("ETL phase=temperature status=start");
    expect(lines.some((l) => l.includes("phase=temperature status=failed"))).toBe(true);
  });
});
