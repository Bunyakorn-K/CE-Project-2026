// Home Assistant gas-pressure collector — reads the otterimju2 manifold
// pressures and loads them into fact_gas_pressure_sample.
//
// SCOPE. This is a SEPARATE, ADDITIVE third-party source. The usage pipeline
// is IRIS Postgres -> main ETL -> ClickHouse and is unaffected by this file.
// Nothing in the Digital Twin or the cycle/revenue KPIs is derived from here,
// and no alert is raised from here. Full contract, provenance and the safety
// boundary: docs/03_data_contracts/ha_gas_sensor_contract.md
//
// WHAT IS COLLECTED — three entities, and only three:
//
//   sensor.otterimju2_gas_pressure_a   -> gas_run_a_pressure
//   sensor.otterimju2_gas_pressure_b   -> gas_run_b_pressure
//   sensor.otterimju2_changeover_pressure -> changeover_filter_pressure
//
// The mapping is an explicit allow-list rather than a pattern, so a new HA
// entity can never be ingested by accident. That matters most for
// `binary_sensor.otterimju2_gas_detector_a/_b`, which despite its entity id
// is NOT a gas detector: measured 2026-09-30 it toggles on a 50.00-50.03%
// daily ratio with a fixed 5-25s cadence and constant attributes — a liveness
// heartbeat. Ingesting it would manufacture a "leak half the time" reading.
//
// HARD RULES:
//   - The HA token comes from HA_TOKEN env, never from source.
//   - 'unavailable' becomes NULL, never 0. The observed numeric minimum is
//     9 psi; a coerced 0 would read as an empty tank.
//   - A missing entity is REPORTED, not silently skipped. An entity that
//     returns nothing in the window is a different fact from an entity that
//     returned rows, and only one of them is a problem.
//   - Every timestamp persisted is UTC (see ./datetime).

import type { ClickHouseClient } from "./clickhouse";
import { toClickHouseUtc, nowUtc, shiftHoursUtc } from "./datetime";

export const GAS_TABLE = "fact_gas_pressure_sample";

/** Semantic channel for each collected entity. Values match the DDL Enum8. */
export type GasChannel =
  | "gas_run_a_pressure"
  | "gas_run_b_pressure"
  | "changeover_filter_pressure";

export const GAS_UNIT = "psi";

/**
 * The complete allow-list. Add a row here only with evidence of what the
 * entity actually measures — never because its name looks right.
 */
export const GAS_CHANNELS: ReadonlyArray<{ channel: GasChannel; entityId: string }> = [
  { channel: "gas_run_a_pressure", entityId: "sensor.otterimju2_gas_pressure_a" },
  { channel: "gas_run_b_pressure", entityId: "sensor.otterimju2_gas_pressure_b" },
  // NOT a changeover pressure. This is the gas FILTER differential pressure;
  // the entity id is misleading and the contract records why.
  { channel: "changeover_filter_pressure", entityId: "sensor.otterimju2_changeover_pressure" }
] as const;

/** The branch this site writes to. Resolved by ops, never inferred. */
export type GasTarget = {
  tenant_id: string;
  branch_id: string;
  branch_slug: string;
};

/** One state-history entry as Home Assistant returns it. */
export type HaHistoryEntry = {
  entity_id?: string;
  state?: string;
  last_changed?: string;
  last_updated?: string;
  attributes?: Record<string, unknown>;
};

/**
 * `GET /api/history/period` returns an array of arrays — one inner array per
 * requested entity, positionally aligned to `filter_entity_id`, and an entity
 * with no states in the window yields an empty inner array.
 */
export type HaHistoryResponse = HaHistoryEntry[][];

export type GasRow = {
  tenant_id: string;
  branch_id: string;
  branch_slug: string;
  channel: GasChannel;
  entity_id: string;
  unit: string;
  value_psi: number | null;
  state_raw: string;
  is_available: number;
  recorded_at: string;
  ingested_at: string;
};

export type GasCollectionResult = {
  inserted: number;
  /** Channels that returned at least one row. */
  channels: string[];
  /**
   * Allow-listed channels that returned NOTHING. Surfaced loudly by the
   * runner: this is the difference between "the shop is closed" and "the
   * entity was renamed", and only one of those is healthy.
   */
  emptyChannels: string[];
  unavailable: number;
  windowStart: string;
  windowEnd: string;
};

export class GasCollectorError extends Error {}

/**
 * Parse a Home Assistant state string into a psi reading.
 *
 * Returns null for anything that is not a finite number — `unavailable`,
 * `unknown`, an empty string, or garbage. It never returns 0 for those: the
 * observed numeric minimum is 9 psi, so 0 is not a sentinel the data uses and
 * substituting it would fabricate a reading.
 */
export function parsePsi(state: string | undefined): number | null {
  if (state === undefined || state === null) return null;
  const trimmed = String(state).trim();
  if (trimmed === "") return null;
  // Reject the sentinels explicitly so the intent is greppable, even though
  // Number() would also yield NaN for them.
  if (trimmed === "unavailable" || trimmed === "unknown") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return value;
}

export function isAvailableState(state: string | undefined): boolean {
  return parsePsi(state) !== null;
}

/**
 * Resolve the sample instant. Home Assistant returns offset-aware ISO strings
 * ("2026-09-30T04:33:12.345+00:00" or "+07:00"), so `Date` yields a true UTC
 * instant. `last_updated` is used rather than `last_changed` because it is the
 * recorder's own timestamp for the sample; `last_changed` only moves when the
 * value differs, which understates how often a reading was taken.
 *
 * An unparseable timestamp is a row we must not invent — it is dropped and
 * counted by the caller, never defaulted to `now`.
 */
export function parseRecordedAt(entry: HaHistoryEntry): Date | null {
  const raw = entry.last_updated ?? entry.last_changed;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Flatten a history response into warehouse rows.
 *
 * The inner arrays are matched to channels BY POSITION, because
 * `minimal_response` strips `entity_id` from every entry except the first and
 * last of each entity. The caller does not request it — see
 * `fetchGasHistory` — but the positional walk is what the documented response
 * shape guarantees, and an entry that does carry `entity_id` is cross-checked
 * against the expected one so a shape change surfaces as a dropped row rather
 * than a mislabelled one.
 */
export function normalizeGasHistory(input: {
  response: HaHistoryResponse;
  target: GasTarget;
  ingestedAt?: Date;
}): { rows: GasRow[]; emptyChannels: GasChannel[] } {
  const { response, target } = input;
  const ingestedAt = input.ingestedAt ?? nowUtc();
  const rows: GasRow[] = [];
  const emptyChannels: GasChannel[] = [];

  if (!Array.isArray(response)) {
    throw new GasCollectorError("Home Assistant returned a non-array history response");
  }

  for (const [index, spec] of GAS_CHANNELS.entries()) {
    const entries = response[index];
    if (!Array.isArray(entries) || entries.length === 0) {
      emptyChannels.push(spec.channel);
      continue;
    }
    for (const entry of entries) {
      // Cross-check rather than trust position blindly.
      if (entry.entity_id !== undefined && entry.entity_id !== spec.entityId) {
        continue;
      }
      const recordedAt = parseRecordedAt(entry);
      if (recordedAt === null) continue;
      const stateRaw = entry.state ?? "";
      const value = parsePsi(stateRaw);
      rows.push({
        tenant_id: target.tenant_id,
        branch_id: target.branch_id,
        branch_slug: target.branch_slug,
        channel: spec.channel,
        entity_id: spec.entityId,
        unit: GAS_UNIT,
        value_psi: value,
        state_raw: stateRaw,
        is_available: value === null ? 0 : 1,
        recorded_at: toClickHouseUtc(recordedAt),
        ingested_at: toClickHouseUtc(ingestedAt)
      });
    }
  }

  return { rows, emptyChannels };
}

/**
 * Fetch the state history for the allow-listed entities over [end - lookbackHours, end].
 *
 * `no_attributes` is requested (the attributes are unused) but `minimal_response`
 * is deliberately NOT: it drops `entity_id` from all but the first and last
 * entry of each entity, which would force the positional walk in
 * `normalizeGasHistory` to be the only thing keeping channels correctly
 * labelled. Three sensors over a few hours is a small response; correctness
 * is worth more than the bytes.
 */
export async function fetchGasHistory(input: {
  baseUrl: string;
  token: string;
  end: Date;
  lookbackHours: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<HaHistoryResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const start = shiftHoursUtc(input.end, -input.lookbackHours);

  // The period start is the PATH segment; `end_time` is the end of the range.
  // Setting end_time to the start (or omitting both) silently widens the
  // window to HA's 1-day default, which is not wrong but is 8x the intended
  // read and hides how much was actually requested.
  const url = new URL(
    `/api/history/period/${encodeURIComponent(start.toISOString())}`,
    input.baseUrl.replace(/\/$/, "")
  );
  url.searchParams.set("filter_entity_id", GAS_CHANNELS.map((c) => c.entityId).join(","));
  url.searchParams.set("end_time", input.end.toISOString());
  url.searchParams.set("no_attributes", "");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.token}`, Accept: "application/json" },
      signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined
    });
  } catch (error) {
    throw new GasCollectorError(
      `Home Assistant unreachable at ${url.origin}: ${String(error)}`
    );
  }
  if (!response.ok) {
    // 401 here almost always means the token was revoked or never provisioned.
    // 404 means the entity ids changed. Both are operator problems, not
    // transient ones, so they are named rather than retried silently.
    const hint =
      response.status === 401
        ? " — the HA token is invalid or revoked"
        : response.status === 404
          ? " — the entity ids may have been renamed"
          : "";
    throw new GasCollectorError(
      `Home Assistant history returned ${response.status}${hint}: ${(await response.text()).slice(0, 500)}`
    );
  }
  return (await response.json()) as HaHistoryResponse;
}

/**
 * Run one collection pass. Idempotent: rows are keyed on
 * (tenant, branch, channel, recorded_at) and versioned by ingested_at, so an
 * overlapping re-poll converges instead of duplicating.
 */
export async function runGasCollector(input: {
  baseUrl: string;
  token: string;
  target: GasTarget;
  warehouse: Pick<ClickHouseClient, "insert">;
  lookbackHours?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<GasCollectionResult> {
  const { baseUrl, token, target, warehouse } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? nowUtc;
  const lookbackHours = input.lookbackHours ?? 3;
  const end = now();

  const response = await fetchGasHistory({
    baseUrl,
    token,
    end,
    lookbackHours,
    fetchImpl,
    timeoutMs: input.timeoutMs
  });

  const { rows, emptyChannels } = normalizeGasHistory({ response, target, ingestedAt: end });
  if (rows.length > 0) {
    await warehouse.insert(GAS_TABLE, rows);
  }

  return {
    inserted: rows.length,
    channels: GAS_CHANNELS.map((c) => c.channel).filter((c) => !emptyChannels.includes(c)),
    emptyChannels,
    unavailable: rows.filter((r) => r.value_psi === null).length,
    windowStart: toClickHouseUtc(shiftHoursUtc(end, -lookbackHours)),
    windowEnd: toClickHouseUtc(end)
  };
}
