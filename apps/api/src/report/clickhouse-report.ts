import { createClickHouseClient, type ClickHouseExecutor } from "../analytics/clickhouse";
import { isDemoModeEnabled } from "../demo-read-client";
import type { Principal } from "../access-store";

// ---------------------------------------------------------------------------
// ClickHouse table shapes (readonly references for query typing)
// ---------------------------------------------------------------------------
type MachineUsageRow = {
  tenant_id: string;
  branch_id: string;
  machine_id: string;
  branch_name: string;
  machine_code: string;
  machine_kind: string;
  revenueSatang: string;
  cycles: string;
  attributedCycles: string;
  usageRows: string;
  started_at: string;
  last_active_at: string;
};

type BranchRow = {
  branch_id: string;
  branch_name: string;
  timezone: string;
  active: string | number;
};

type MachineStateRow = {
  tenant_id?: string;
  machine_id: string;
  branch_id: string;
  machine_code: string;
  machine_kind: string;
  branch_name: string;
  status: string | null;
  last_active_at: string | null;
  cycle_count: string | number;
  /** Every usage row for this machine in the window, regardless of status.
   *  `count()` would count the placeholder row a LEFT JOIN emits for a
   *  machine with no usage, because `join_use_nulls = 1` only changes the
   *  column's type, not whether the row exists. */
  usage_rows: string | number;
};

export function buildBranchSQL(): string {
  return `
SELECT branch_id, branch_name, timezone, active
FROM dim_branch FINAL
WHERE active = 1
  AND ({branchId:String} = '' OR toString(branch_id) = {branchId:String})
GROUP BY tenant_id, branch_id, branch_name, timezone, active
ORDER BY branch_name`;
}

/**
 * Dashboard aggregation, one row per (tenant, branch, machine).
 *
 * `cycles` counts usage ROWS in the paid/finished statuses — the canonical
 * definition decided 2026-09-29 and recorded in
 * docs/04_traceability/RTM_matrix.md ("Canonical cycle definition"). It was
 * `uniqExactIf(machine_session_id, status IN (2, 4))` before that.
 *
 * Why rows and not sessions: `machine_session_id` is `Nullable(String)` and is
 * NULL on 67.8933% of real usage rows (5,369 of 7,908, measured 2026-09-30
 * 11:39:11 UTC), so a distinct-session count silently drops the unattributed
 * majority of the work. On the 2026-09-29 measurement the same gap read
 * 63.91% (2,849 of 4,458, 2026-07-22 → 2026-09-25): the real warehouse's
 * ฿16,480,000 revenue over 1,314 such "cycles" is ฿125.42 each, about three
 * times a real Thai wash, while the same revenue over 3,905 rows is ฿42.20 —
 * inside the plausible ฿40–45 band for a Thai wash, and the evidence the
 * 2026-09-29 decision rests on.
 *
 * Re-measured 2026-09-30 11:39:11 UTC over 7,908 rows, after the warehouse
 * recovery merge: ฿322,650 of paid/finished revenue is ฿203.05 over the 1,589
 * session-distinct cycles and ฿48.40 over the 6,666 rows. So the refreshed
 * figure is ABOVE the ฿40–45 band, and this no longer re-confirms the decision
 * on price plausibility. The decision is unchanged and the ranking is unchanged
 * — the row count is still the closest of the four, and the session-distinct
 * alternatives are still off by roughly 3× to 5× — but the
 * argument that actually carries the decision is the cardinality one below,
 * not the price band. The unattributed recovered days are a plausible cause of
 * the rise (rows without a session id add to a row count and to no
 * session-distinct count), and that cause is NOT proven; it would need a
 * per-day attribution breakdown for 2026-08-31…2026-09-16, which has not been
 * run. The cardinality diagnostic
 * (`apps/api/scripts/cycle-cardinality-diagnostic.ts`) measured that one real
 * session id spans exactly one row and exactly one status, so for attributed
 * rows the two definitions are identical; the divergence was entirely the
 * missing attribution. That shape was measured 2026-09-29 and has NOT been
 * re-measured since. `status IN ('paid', 'finished')` is a data-contract
 * decision (docs/03_data_contracts/data_contracts.md) and is unchanged.
 *
 * The unattributed share is a live metric, not a constant: it moves as the ETL
 * ingests the IRIS backlog and as recovery merges land. Never quote it without a
 * measurement date. Figures here are recorded in
 * docs/04_traceability/RTM_matrix.md ("Canonical cycle definition").
 *
 * BY NAME, not by number. This was `status IN (2, 4)`, which was only correct
 * while the Enum8 read 'running'=3, 'finished'=4. `status` is now numbered by
 * the IRIS lifecycle order (admitted=3, running=4, finished=5) so that
 * `status >= 3` means "past the queue"; under that numbering the same numbers
 * would have silently become `paid` + `running` and moved the revenue line.
 * ClickHouse resolves a string literal against an Enum8 by name, so the names
 * are immune to the renumbering (verified on ClickHouse 26.3). Nothing else in
 * this file may reintroduce a numeric status literal.
 *
 * The gap is still measured rather than assumed away: `attributedCycles`
 * counts how many of the counted rows carry a non-null `machine_session_id`,
 * which is what `cycleAttribution` surfaces. Revenue is untouched — it is
 * separately correct and separately verified.
 */
export function buildDashboardSQL(): string {
  return `
SELECT
  u.tenant_id AS tenant_id,
  u.branch_id AS branch_id,
  u.machine_id AS machine_id,
  b.branch_name AS branch_name,
  m.machine_code AS machine_code,
  m.machine_kind AS machine_kind,
  sumIf(u.amount_satang, u.status IN ('paid', 'finished')) AS revenueSatang,
  countIf(u.status IN ('paid', 'finished')) AS cycles,
  countIf(u.status IN ('paid', 'finished') AND u.machine_session_id IS NOT NULL) AS attributedCycles,
  count() AS usageRows,
  max(u.started_at) AS last_active_at
FROM fact_machine_usage AS u FINAL
INNER JOIN dim_branch AS b FINAL ON u.tenant_id = b.tenant_id AND u.branch_id = b.branch_id
INNER JOIN dim_machine AS m FINAL ON u.tenant_id = m.tenant_id AND u.branch_id = m.branch_id AND u.machine_id = m.machine_id
WHERE u.started_at >= {from:String}
  AND u.started_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(u.branch_id) = {branchId:String})
GROUP BY u.tenant_id, u.branch_id, u.machine_id, b.branch_name, m.machine_code, m.machine_kind`;
}

export function buildMachineStateSQL(): string {
  return `
SELECT
  m.tenant_id AS tenant_id,
  m.machine_id AS machine_id,
  m.branch_id AS branch_id,
  b.branch_name AS branch_name,
  m.machine_code AS machine_code,
  m.machine_kind AS machine_kind,
  argMax(u.status, u.started_at) AS status,
  max(u.started_at) AS last_active_at,
  countIf(u.status IN ('paid', 'finished')) AS cycle_count,
  countIf(u.status IS NOT NULL) AS usage_rows
FROM dim_machine AS m FINAL
INNER JOIN dim_branch AS b FINAL ON m.tenant_id = b.tenant_id AND m.branch_id = b.branch_id
LEFT JOIN fact_machine_usage AS u FINAL ON
  m.tenant_id = u.tenant_id
  AND m.branch_id = u.branch_id
  AND m.machine_id = u.machine_id
  AND u.started_at >= {from:String}
  AND u.started_at < plus(toDate({to:String}), 1)
WHERE m.active = 1
  AND b.active = 1
  AND ({branchId:String} = '' OR toString(m.branch_id) = {branchId:String})
GROUP BY m.tenant_id, m.branch_id, m.machine_id, b.branch_name, m.machine_code, m.machine_kind
ORDER BY last_active_at DESC
SETTINGS join_use_nulls = 1`;
}

export type BranchInfo = {
  branchId: string;
  branchName: string;
  timezone: string;
  active: boolean;
};

// Mirrors fact_machine_usage.status (apps/etl/src/schema.ts) plus the
// presentation-only `idle`/`offline` states. `finished` and `paid` stay
// separate members: docs/06_ml/ml-training-data-guide.md defines a
// paid_ratio over both, and collapsing them made that ratio meaningless.
export type MachineStatus =
  | "running"
  | "paid"
  | "finished"
  | "cancelled"
  | "admitted"
  | "pending"
  | "idle"
  | "offline"
  | "unknown";

export type MachineInfo = {
  tenantId: string;
  machineId: string;
  branchId: string;
  machineCode: string;
  machineKind: "washer" | "dryer";
  branchName: string;
  status: MachineStatus;
  lastActiveAt: string | null;
  /** How old the newest usage evidence for this machine is. This is a
   *  SEPARATE axis from `status`: `status` is whatever the last usage row
   *  said, which can be days old, while `freshness` says how much the reader
   *  should trust it as a statement about right now. Collapsing them is what
   *  let the Digital Twin render a week-old `running` exactly like a live one.
   *
   *  Computed here rather than in the view so the twin and the live endpoint
   *  cannot drift apart. The thresholds are the ones
   *  `apps/web/src/lib/machine-status.ts` labels in Thai. */
  freshness: "fresh" | "stale" | "unavailable";
  freshnessReason: string | null;
  cycleCount: number | null;
  /** Which definition `cycleCount` was taken from. It is NOT `machine_session_id`:
   *  the count is `countIf(status IN ('paid', 'finished'))` over usage rows, the
   *  canonical definition, so labelling it by that nullable field would
   *  misdescribe it.
   *
   *  `usage_row` means usage rows exist for this machine in the window — and
   *  `cycleCount` may legitimately be `0`, because a row in
   *  `pending_payment`/`admitted`/`cancelled` is not a counted cycle. `0` and
   *  "never used" are different facts and the view used to render both as
   *  `unavailable`, telling a technician investigating a busy machine that it
   *  had no usage at all. `unavailable` is now reserved for a source that
   *  reported a row count and it was zero. `unknown` is for a source with no
   *  usage-row concept at all — the IRIS/demo projection — which is a
   *  different claim from "this machine has no usage". */
  cycleCountSource: "usage_row" | "unavailable" | "unknown";
};

/** How much of the dashboard `cycles` count rests on a `machine_session_id`.
 *  `countedRows` is the denominator the KPI is computed over, and
 *  `attributedRows` is how many of those rows carry the field. The difference
 *  is a real, measured gap, not a rounding artifact: on the production
 *  warehouse 67.8933% of usage rows have no session id (5,369 of 7,908,
 *  measured 2026-09-30 11:39:11 UTC; 63.91% of 4,458 rows on 2026-09-29), so a
 *  reader who is not told this will read a row count as a fully attributed
 *  session count. */
export type CycleAttribution = {
  countedRows: number;
  attributedRows: number;
  unattributedRows: number;
};

export type DashboardTotals = {
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

export type DashboardBranch = {
  branchId: string;
  branchName: string;
  revenueSatang: number | null;
  cycles: number;
  machines: number;
  running: number;
};

export type DashboardData = {
  from: string;
  to: string;
  source: "clickhouse" | "demo";
  /** Presence signal: usage rows in range inside the resolved branch scope.
   *  0 proves "no usage at all in this window"; a positive value is the number
   *  of usage rows, not the number of machine/status groups they aggregate into.
   *  `null` means the source cannot count usage rows (the IRIS/demo projection
   *  has no such field), so presence is unknown and must not be presented as
   *  either empty or populated. */
  usageRowsInRange: number | null;
  /** How much of `totals.cycles` carries a `machine_session_id`. Additive in
   *  the same sense as `usageRowsInRange`: always present on the ClickHouse
   *  path (including as a zeroed measurement for an empty window), and `null`
   *  on the IRIS/demo path, which cannot measure attribution at all. A `null`
   *  here means the gap is unknown — never that the gap is zero. */
  cycleAttribution: CycleAttribution | null;
  totals: DashboardTotals;
  branches: DashboardBranch[];
};

// ---------------------------------------------------------------------------
// Query functions (all async — ClickHouse returns Promise)
// ---------------------------------------------------------------------------

function isFreshUsage(lastActiveAt: string | null): boolean {
  if (!lastActiveAt) return false;
  const age = Date.now() - new Date(lastActiveAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= 30 * 60 * 1000;
}

/** Freshness thresholds, shared with the `/api/report/live` projection in
 *  `apps/api/src/index.ts`. Both call this so the twin and the live snapshot
 *  cannot disagree about whether a machine's evidence is current. */
export const FRESH_MAX_AGE_MS = 5 * 60 * 1000;
export const STALE_MAX_AGE_MS = 30 * 60 * 1000;

export function usageFreshnessOf(lastActiveAt: string | null): MachineInfo["freshness"] {
  if (!lastActiveAt) return "unavailable";
  const age = Date.now() - new Date(lastActiveAt).getTime();
  // A timestamp in the future is not evidence of anything; treating it as
  // fresh would let a clock skew read as a live machine.
  if (!Number.isFinite(age) || age < 0) return "unavailable";
  if (age <= FRESH_MAX_AGE_MS) return "fresh";
  if (age <= STALE_MAX_AGE_MS) return "stale";
  return "unavailable";
}

/** The reason is English and machine-readable: it is a contract field, and the
 *  web layer maps it to Thai by keying on `freshness` (see
 *  `apps/web/src/lib/machine-status.ts`), never by matching this prose. */
function usageFreshnessReasonOf(freshness: MachineInfo["freshness"]): string | null {
  if (freshness === "fresh") return null;
  if (freshness === "stale") return "Usage data is older than 30 minutes";
  return "No recent usage evidence is available for this machine";
}

function freshnessFields(lastActiveAt: string | null): Pick<MachineInfo, "freshness" | "freshnessReason"> {
  const freshness = usageFreshnessOf(lastActiveAt);
  return { freshness, freshnessReason: usageFreshnessReasonOf(freshness) };
}

export async function queryBranches(ch: ClickHouseExecutor, branchId?: string): Promise<BranchInfo[]> {
  const rows = await ch<BranchRow>(buildBranchSQL(), { branchId: branchId ?? "" });
  return rows.map((r) => ({
    branchId: r.branch_id,
    branchName: r.branch_name,
    timezone: r.timezone,
    active: r.active === "1" || r.active === 1
  }));
}

export async function queryDashboard(
  ch: ClickHouseExecutor,
  from: string,
  to: string,
  branchId?: string
): Promise<DashboardData> {
  const [rows, currentStates] = await Promise.all([
    ch<MachineUsageRow>(buildDashboardSQL(), { from, to, branchId: branchId ?? "" }),
    queryMachineStates(ch, to, to, branchId)
  ]);

  const branchMap = new Map<
    string,
    { branchId: string; branchName: string; revenueSatang: number; cycles: number; machines: Set<string>; running: number }
  >();
  let totalRevenue = 0;
  let totalCycles = 0;
  const machines = new Set<string>();
  let attributedCycles = 0;

  for (const state of currentStates) {
    const branchKey = `${state.tenantId}:${state.branchId}`;
    const machineKey = `${branchKey}:${state.machineId}`;
    machines.add(machineKey);
    const current = branchMap.get(branchKey) ?? {
      branchId: state.branchId,
      branchName: state.branchName,
      revenueSatang: 0,
      cycles: 0,
      machines: new Set<string>(),
      running: 0
    };
    current.machines.add(machineKey);
    if (state.status === "running" && isFreshUsage(state.lastActiveAt)) current.running += 1;
    branchMap.set(branchKey, current);
  }

  for (const r of rows) {
    const branchKey = `${r.tenant_id}:${r.branch_id}`;
    const machineKey = `${branchKey}:${r.machine_id}`;
    machines.add(machineKey);
    const rev = Number(r.revenueSatang) || 0;
    const cyc = Number(r.cycles) || 0;
    totalRevenue += rev;
    totalCycles += cyc;
    attributedCycles += Number(r.attributedCycles) || 0;

    const existing = branchMap.get(branchKey) ?? {
      branchId: r.branch_id,
      branchName: r.branch_name,
      revenueSatang: 0,
      cycles: 0,
      machines: new Set<string>(),
      running: 0
    };
    existing.revenueSatang += rev;
    existing.cycles += cyc;
    existing.machines.add(machineKey);
    branchMap.set(branchKey, existing);
  }

  return {
    from,
    to,
    source: "clickhouse",
    usageRowsInRange: rows.reduce((total, r) => total + (Number(r.usageRows) || 0), 0),
    // Attribution is measured over the same rows the KPI counts, so
    // `unattributedRows` is exactly the number of cycles with no session id
    // behind them. A `Math.max(0, …)` guard is deliberate: it keeps an
    // inconsistent pair from reporting a negative gap, which would read as
    // more attributed rows than there are counted rows.
    cycleAttribution: {
      countedRows: totalCycles,
      attributedRows: attributedCycles,
      unattributedRows: Math.max(0, totalCycles - attributedCycles)
    },
    totals: {
      revenueSatang: totalRevenue,
      cycles: totalCycles,
      machines: machines.size,
      running: Array.from(branchMap.values()).reduce((total, branch) => total + branch.running, 0)
    },
    branches: Array.from(branchMap.values()).map((b) => ({
      branchId: b.branchId,
      branchName: b.branchName,
      revenueSatang: b.revenueSatang,
      cycles: b.cycles,
      machines: b.machines.size,
      running: b.running
    }))
  };
}

export async function queryMachineStates(
  ch: ClickHouseExecutor,
  from: string,
  to: string,
  branchId?: string
): Promise<MachineInfo[]> {
  const rows = await ch<MachineStateRow>(buildMachineStateSQL(), { from, to, branchId: branchId ?? "" });

  const statusMap: Record<string, MachineInfo["status"]> = {
    running: "running",
    paid: "paid",
    pending_payment: "pending",
    // `finished` and `paid` are separate fact_machine_usage enum members and
    // stay separate here. The exact upstream difference is still unresolved —
    // see docs/03_data_contracts/data_contracts.md.
    finished: "finished",
    cancelled: "cancelled",
    admitted: "admitted",
    idle: "idle"
  };

  return rows.map((r: MachineStateRow) => {
    // Three cases, not two. A machine can have usage rows and still count zero
    // cycles, because `pending_payment`/`admitted`/`cancelled` rows are usage
    // without being a finished cycle. Collapsing that into `null` is what made
    // the view claim the machine had no usage rows at all.
    //
    // `usageRows` comes from a separate aggregate rather than from
    // `countedCycles > 0`, precisely so that distinction survives. When the
    // source reports no row count (a pre-migration response, or the IRIS/demo
    // projection which has no such field) the denominator is unknown, and an
    // unknown denominator must not become a usage-row claim — nor a bare
    // number with no stated basis.
    const usageRows = Number(r.usage_rows);
    const countedCycles = Number(r.cycle_count) || 0;
    const hasUsageRows = Number.isFinite(usageRows) && usageRows > 0;
    const cycleCount = hasUsageRows ? countedCycles : null;
    return {
      tenantId: r.tenant_id ?? "unknown",
      machineId: r.machine_id,
      branchId: r.branch_id,
      machineCode: r.machine_code,
      machineKind: r.machine_kind as "washer" | "dryer",
      branchName: r.branch_name,
      status: statusMap[r.status ?? ""] ?? "unknown",
      lastActiveAt: r.last_active_at || null,
      ...freshnessFields(r.last_active_at || null),
      cycleCount,
      cycleCountSource: hasUsageRows ? "usage_row" : "unavailable"
    };
  });
}

// ---------------------------------------------------------------------------
// Events (fact_machine_event)
// ---------------------------------------------------------------------------

type MachineEventRow = {
  event_id: string;
  branch_id: string;
  machine_id: string;
  machine_code: string;
  occurred_at: string;
  kind: string;
  phase: string | null;
};

/**
 * Event feed for one window, newest first.
 *
 * `machineCode` comes from dim_machine rather than the event table: fact_machine_event
 * keys on machine_id alone, and joining costs nothing on an empty table but keeps
 * the mapping in one place if events ever start arriving.
 *
 * The window predicate is half-open on the upper bound (`< toDate(to) + 1`) to match
 * every other query here, so an event at exactly midnight on the last day is included
 * rather than falling between two ranges.
 *
 * `FINAL` appears on dim_machine but NOT on fact_machine_event, unlike every other
 * query in this file. That asymmetry is required, not an oversight: dim_machine is a
 * ReplacingMergeTree whose rows are superseded in place, so FINAL is what makes the
 * join see current inventory, while fact_machine_event is a plain MergeTree holding an
 * append-only log. ClickHouse REJECTS FINAL there outright -- `Storage MergeTree doesn't
 * support FINAL. (ILLEGAL_FINAL)` -- so carrying the modifier over from the sibling
 * queries would make this route throw on every call in production. An append-only log
 * has no duplicate rows to collapse, so nothing is lost by omitting it.
 *
 * The join casts the DIMENSION side to String rather than parsing the event side as a
 * UUID. machine_id is `UUID` in dim_machine but `String` in fact_machine_event, and
 * ClickHouse refuses to join the two outright -- `There is no supertype for types UUID,
 * String ... (NO_COMMON_TYPE)`. Converting with toUUID() would typecheck but throw on
 * any event row whose machine_id is not a parseable UUID; toString() on the dimension
 * side is total, and equality of the two renderings is the same predicate.
 */
export function buildEventsSQL(): string {
  return `
SELECT
  e.event_id AS event_id,
  e.branch_id AS branch_id,
  e.machine_id AS machine_id,
  m.machine_code AS machine_code,
  e.occurred_at AS occurred_at,
  toString(e.kind) AS kind,
  toString(e.phase) AS phase
FROM fact_machine_event AS e
INNER JOIN dim_machine AS m FINAL ON
  e.tenant_id = m.tenant_id
  AND e.branch_id = m.branch_id
  AND e.machine_id = toString(m.machine_id)
WHERE e.occurred_at >= {from:String}
  AND e.occurred_at < plus(toDate({to:String}), 1)
  AND ({branchId:String} = '' OR toString(e.branch_id) = {branchId:String})
  AND ({cursorOccurredAt:String} = '' OR (e.occurred_at, e.event_id) < ({cursorOccurredAt:String}, {cursorEventId:String}))
ORDER BY e.occurred_at DESC, e.event_id DESC
LIMIT {limit:UInt32}
SETTINGS join_use_nulls = 1`;
}

/** One past the requested page, so the presence of a row past `limit` is what
 *  signals "there is more" rather than a second count query. */
export async function queryEvents(
  ch: ClickHouseExecutor,
  params: { from: string; to: string; branchId?: string; cursor?: string; limit?: number }
): Promise<{ events: MachineEventRow[]; hasMore: boolean }> {
  const limit = params.limit ?? EVENTS_DEFAULT_LIMIT;
  const cursor = params.cursor ? parseEventCursor(params.cursor) : null;
  const rows = await ch<MachineEventRow>(buildEventsSQL(), {
    from: params.from,
    to: params.to,
    branchId: params.branchId ?? "",
    cursorOccurredAt: cursor?.occurredAt ?? "",
    cursorEventId: cursor?.eventId ?? "",
    limit: limit + 1
  });
  return { events: rows.slice(0, limit), hasMore: rows.length > limit };
}

export const EVENTS_DEFAULT_LIMIT = 50;

/**
 * Keyset cursor over (occurred_at, event_id), which together are unique per event
 * and match the ORDER BY, so paging cannot skip or repeat a row the way an offset
 * would if events arrived mid-walk.
 *
 * Encoded rather than a bare "occurredAt|eventId" pair because event ids are opaque
 * strings from the source and must not be able to forge a cursor boundary.
 */
export function encodeEventCursor(event: { occurredAt: string; eventId: string }): string {
  return Buffer.from(`${event.occurredAt}|${event.eventId}`, "utf8").toString("base64url");
}

export function parseEventCursor(cursor: string): { occurredAt: string; eventId: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  // Split on the FIRST separator, not the last: occurredAt is a ClickHouse
  // DateTime and cannot contain "|", while eventId is an opaque source string
  // that can. Splitting on the last separator would silently truncate an id
  // that contains one, paging from a boundary that never existed and either
  // repeating or skipping rows.
  const separator = decoded.indexOf("|");
  if (separator <= 0) {
    throw new Error("INVALID_CURSOR");
  }
  return { occurredAt: decoded.slice(0, separator), eventId: decoded.slice(separator + 1) };
}
