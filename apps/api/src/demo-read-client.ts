import type {
  IrisAlert,
  IrisAlerts,
  IrisBranch,
  IrisDashboard,
  IrisEvent,
  IrisEvents,
  IrisLiveMachine,
  IrisLiveSnapshot,
  ReportingEnvelope,
  TelemetryCoverage
} from "./iris-read-client";

const CONTRACT_VERSION = "demo-2026-07-19";

const branches: IrisBranch[] = [
  {
    id: "1cb64759-1d45-4ea5-a7ec-847875698a42",
    code: "R2-01",
    name: "Rama II",
    timezone: "Asia/Bangkok",
    status: "active"
  },
  {
    id: "94fc1997-8edb-4a63-bf4e-3f2aaec26395",
    code: "BKK-02",
    name: "Bang Khae",
    timezone: "Asia/Bangkok",
    status: "active"
  }
];

const available = (sourceField?: string): TelemetryCoverage => ({ available: true, ...(sourceField ? { sourceField } : {}) });
const unavailable = (reason: string): TelemetryCoverage => ({ available: false, reason });

export function createDemoReadClient(now: () => Date = () => new Date()) {
  function envelope<T extends object>(data: T): ReportingEnvelope & T {
    return {
      contractVersion: CONTRACT_VERSION,
      source: "demo",
      fetchedAt: now().toISOString(),
      ...data
    };
  }

  return {
    async getBranches() {
      return envelope({ branches });
    },

    async getDashboard(query: { branchId?: string; from?: string; to?: string }): Promise<IrisDashboard> {
      const selectedBranches = query.branchId ? branches.filter((branch) => branch.id === query.branchId) : branches;
      const resultBranches = selectedBranches.map((branch, index) => ({
        branch,
        kpi: {
          revenueSatang: index === 0 ? 184_000 : 126_500,
          cycles: index === 0 ? 31 : 24,
          machineCount: index === 0 ? 3 : 2,
          totalCycleMinutes: index === 0 ? 1_185 : 760,
          utilization: index === 0 ? 0.31 : 0.26
        }
      }));
      return envelope({
        range: dateRange(query, now),
        branches: resultBranches,
        totals: {
          revenueSatang: resultBranches.reduce((total, item) => total + item.kpi.revenueSatang, 0),
          cycles: resultBranches.reduce((total, item) => total + item.kpi.cycles, 0),
          machineCount: resultBranches.reduce((total, item) => total + item.kpi.machineCount, 0)
        }
      });
    },

    async getLiveSnapshot(branchId: string): Promise<IrisLiveSnapshot> {
      return envelope({ branchId, machines: liveMachines(branchId, now) });
    },

    async getAlerts(query: { branchId?: string; from?: string; to?: string }): Promise<IrisAlerts> {
      const detectedAt = new Date(now().getTime() - 12 * 60 * 1000).toISOString();
      const alerts: IrisAlert[] = [
        {
          id: "demo-alert-d02",
          branchId: branches[0]!.id,
          machineId: "demo-r2-d02",
          ruleId: "demo-stale-state",
          ruleUpdatedAt: null,
          ruleVersion: null,
          severity: "warning",
          title: "Dryer D-02 state is delayed",
          detail: "Demo alert: inspect machine heartbeat before customer use.",
          tags: ["demo", "telemetry"],
          evidence: { machineId: "demo-r2-d02", branchId: branches[0]!.id },
          detectedAt,
          acknowledgedAt: null,
          coverage: { ruleVersion: unavailable("Demo alert rules have no version") }
        },
        {
          id: "demo-alert-gas",
          branchId: branches[0]!.id,
          machineId: null,
          ruleId: "demo-gas-unavailable",
          ruleUpdatedAt: null,
          ruleVersion: null,
          severity: "info",
          title: "Gas telemetry is unavailable",
          detail: "Demo alert: gas sensor fields are intentionally unavailable.",
          tags: ["demo", "coverage"],
          evidence: { branchId: branches[0]!.id },
          detectedAt: new Date(now().getTime() - 48 * 60 * 1000).toISOString(),
          acknowledgedAt: null,
          coverage: { ruleVersion: unavailable("Demo alert rules have no version") }
        }
      ];
      return envelope({ alerts: query.branchId ? alerts.filter((alert) => alert.branchId === query.branchId) : alerts });
    },

    async getEvents(query: { branchId?: string; from?: string; to?: string; cursor?: string; limit?: number }): Promise<IrisEvents> {
      const branchId = query.branchId ?? branches[0]!.id;
      const event: IrisEvent = {
        eventId: "demo-event-w01",
        branchId,
        machineId: "demo-r2-w01",
        machineCode: "W-01",
        occurredAt: new Date(now().getTime() - 3 * 60 * 1000).toISOString(),
        kind: "telemetry",
        phase: "washing",
        state: {
          phase: "washing",
          remainingSeconds: 1_140,
          temperatureC: 31.2,
          doorStatus: "locked",
          coinbox: "normal",
          paidSatang: 6_000,
          errorCode: null
        },
        coverage: demoCoverage()
      };
      return envelope({ events: [event], nextCursor: null });
    }
  };
}

export function isDemoModeEnabled() {
  return process.env.LAUNDRYTWIN_DEMO_MODE === "true";
}

function dateRange(query: { from?: string; to?: string }, now: () => Date) {
  const end = query.to ?? now().toISOString();
  return { from: query.from ?? new Date(new Date(end).getTime() - 24 * 60 * 60 * 1000).toISOString(), to: end };
}

function liveMachines(branchId: string, now: () => Date): IrisLiveMachine[] {
  if (branchId !== branches[0]!.id) {
    return [
      machine("demo-bkk-w01", "W-01", "washer", "ready", "fresh", now, {
        remainingSeconds: 0,
        temperatureC: 27.5,
        doorStatus: "locked",
        coinbox: "normal"
      }),
      machine("demo-bkk-d01", "D-01", "dryer", "drying", "fresh", now, {
        remainingSeconds: 420,
        temperatureC: 51.1,
        doorStatus: "locked",
        coinbox: "normal"
      })
    ];
  }

  return [
    machine("demo-r2-w01", "W-01", "washer", "washing", "fresh", now, {
      remainingSeconds: 1_140,
      temperatureC: 31.2,
      doorStatus: "locked",
      coinbox: "normal"
    }),
    machine("demo-r2-w02", "W-02", "washer", "ready", "fresh", now, {
      remainingSeconds: 0,
      temperatureC: 27.5,
      doorStatus: "locked",
      coinbox: "low"
    }),
    machine("demo-r2-d02", "D-02", "dryer", null, "unavailable", now, {})
  ];
}

function machine(
  id: string,
  code: string,
  kind: string,
  state: string | null,
  freshness: IrisLiveMachine["freshness"],
  now: () => Date,
  telemetry: Partial<NonNullable<IrisLiveMachine["telemetry"]>>
): IrisLiveMachine {
  const unavailableState = freshness === "unavailable";
  return {
    id,
    code,
    kind,
    configuredStatus: "active",
    state,
    remainingSeconds: telemetry.remainingSeconds ?? null,
    lastSeen: unavailableState ? null : new Date(now().getTime() - 25_000).toISOString(),
    freshness,
    ...(unavailableState ? { reason: "Demo data: machine state source unavailable" } : {}),
    telemetry: unavailableState
      ? undefined
      : {
          phase: state,
          remainingSeconds: telemetry.remainingSeconds ?? null,
          temperatureC: telemetry.temperatureC ?? null,
          doorStatus: telemetry.doorStatus ?? null,
          coinbox: telemetry.coinbox ?? null,
          paidSatang: null,
          errorCode: null
        },
    coverage: unavailableState
      ? { liveState: unavailable("Demo data: machine state source unavailable") }
      : demoCoverage()
  };
}

function demoCoverage(): Record<string, TelemetryCoverage> {
  return {
    temperatureC: available("temperature_f"),
    doorStatus: available("door"),
    coinbox: available("coinbox"),
    paidSatang: unavailable("Demo state omits paid_satang"),
    registerMapVersion: unavailable("Demo state omits register-map version"),
    gasPressure: unavailable("Demo state omits gas-pressure telemetry"),
    gasLeakDetected: unavailable("Demo state omits gas-leak telemetry")
  };
}
