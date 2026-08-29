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
import type { TemperatureCursor, UsageCursor, Watermark, WatermarkStore } from "../src/watermark.js";

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

function usageRow(id: string, createdMinute: number): UsageRow {
  return {
    tenant_id: "ten1",
    branch_id: "br1",
    machine_id: "m1",
    usage_id: `usage-${id}`,
    program_id: 2,
    program_name: "standard",
    started_at: new Date(`2026-08-29T${String(createdMinute).padStart(2, "0")}:00:00.000Z`),
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
    created_at: new Date(`2026-08-29T${String(createdMinute).padStart(2, "0")}:00:00.000Z`),
    updated_at: new Date(`2026-08-29T${String(createdMinute).padStart(2, "0")}:05:00.000Z`),
  };
}

function tempRow(id: string, minute: number): TemperatureSampleRow {
  return {
    tenant_id: "ten1",
    branch_id: "br1",
    machine_id: "m1",
    event_id: id,
    seq: "1",
    frame_seq: null,
    occurred_at: new Date(`2026-08-29T${String(minute).padStart(2, "0")}:00:00.000Z`),
    ingested_at: new Date(`2026-08-29T${String(minute).padStart(2, "0")}:00:00.000Z`),
    temperature_f: 92,
    phase: "wash",
  };
}

function fakeSource(rows: { usages: UsageRow[]; temps: TemperatureSampleRow[] }): MachineUsageSource {
  return {
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
    async listTemperatureSince(since: TemperatureCursor, options = { limit: 50000 }) {
      return rows.temps.filter((r) => r.ingested_at > new Date(since.at)).slice(0, options.limit ?? 50000);
    },
    async close() {},
  };
}

function fakeWatermarks(): ReturnType<typeof makeWatermarkStore> {
  const file = new Map<string, string>();
  const saved: Array<Watermark> = [];
  return makeWatermarkStore(file, saved);
}

function makeWatermarkStore(file: Map<string, string>, saved: Array<Watermark>) {
  const empty: Watermark = { usageCreatedAt: null, temperatureIngestedAt: null, usage: null, temperature: null };
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

    const result = await runEtl({ source, warehouse, watermarks, sinceFallbackDays: 30 });

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
    });
  });

  it("loads all usage and temperature batches and advances watermarks to the last row", async () => {
    const log: Array<{ op: string; args?: unknown }> = [];
    const warehouse = fakeWarehouse(log);
    const usages = [usageRow("u1", 1), usageRow("u2", 2)];
    const temps = [tempRow("t1", 1), tempRow("t2", 2)];
    const source = fakeSource({ usages, temps });
    const watermarks = fakeWatermarks();

    const result = await runEtl({ source, warehouse, watermarks, usageBatchSize: 5, temperatureBatchSize: 5, sinceFallbackDays: 30 });

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