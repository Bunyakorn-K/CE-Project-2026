import { createDemoReadClient, isDemoModeEnabled } from "./demo-read-client";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type TelemetryCoverage = {
  available: boolean;
  reason?: string;
  sourceField?: string;
  transform?: string;
};

export type ReportingEnvelope = {
  contractVersion: string;
  source: "postgres" | "durable-object" | "demo";
  fetchedAt: string;
};

export type IrisBranch = {
  id: string;
  code: string;
  name: string;
  timezone: string;
  status: string;
};

export type IrisDashboard = ReportingEnvelope & {
  range: { from: string; to: string };
  branches: Array<{
    branch: IrisBranch;
    kpi: {
      revenueSatang: number;
      cycles: number;
      machineCount: number;
      totalCycleMinutes: number;
      utilization: number | null;
    };
  }>;
  totals: { revenueSatang: number; cycles: number; machineCount: number };
};

export type IrisLiveMachine = {
  id: string;
  code: string;
  kind: string;
  configuredStatus: string;
  state: string | null;
  remainingSeconds: number | null;
  lastSeen: string | null;
  freshness: "fresh" | "stale" | "unavailable";
  reason?: string;
  telemetry?: {
    phase: string | null;
    remainingSeconds: number | null;
    temperatureC: number | null;
    doorStatus: string | null;
    coinbox: string | null;
    paidSatang: number | null;
    errorCode: number | null;
  };
  coverage: Record<string, TelemetryCoverage>;
};

export type IrisLiveSnapshot = ReportingEnvelope & {
  branchId: string;
  machines: IrisLiveMachine[];
};

export type IrisAlert = {
  id: string;
  branchId: string | null;
  machineId: string | null;
  ruleId: string | null;
  ruleUpdatedAt: string | null;
  ruleVersion: string | null;
  severity: string;
  title: string;
  detail: string | null;
  tags: string[];
  evidence: Record<string, unknown>;
  detectedAt: string;
  acknowledgedAt: string | null;
  coverage: Record<string, TelemetryCoverage>;
};

export type IrisAlerts = ReportingEnvelope & { alerts: IrisAlert[] };

export type IrisEvent = {
  eventId: string;
  branchId: string;
  machineId: string;
  machineCode: string;
  occurredAt: string;
  kind: string;
  phase: string | null;
  state: IrisLiveMachine["telemetry"];
  coverage: Record<string, TelemetryCoverage>;
};

export type IrisEvents = ReportingEnvelope & { events: IrisEvent[]; nextCursor: string | null };

export class IrisReadUnavailableError extends Error {
  constructor() {
    super("IRIS read API is not configured");
    this.name = "IrisReadUnavailableError";
  }
}

export class IrisReadResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null
  ) {
    super(message);
    this.name = "IrisReadResponseError";
  }
}

export type IrisReadClientOptions = {
  baseUrl?: string;
  apiKey?: string;
  fetcher?: Fetcher;
};

export function createIrisReadClient(options: IrisReadClientOptions = {}) {
  if (isDemoModeEnabled()) {
    return createDemoReadClient();
  }

  const baseUrl = options.baseUrl ?? process.env.IRIS_READ_BASE_URL;
  const apiKey = options.apiKey ?? process.env.IRIS_LAUNDRYGO_READ_API_KEY;
  const fetcher = options.fetcher ?? fetch;

  async function get<T extends ReportingEnvelope>(path: string, query?: Record<string, string | number | undefined>) {
    if (!baseUrl || !apiKey) {
      throw new IrisReadUnavailableError();
    }

    const url = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { "x-laundrygo-read-key": apiKey, accept: "application/json" }
      });
    } catch {
      throw new IrisReadResponseError("IRIS read API could not be reached");
    }

    if (!response.ok) {
      throw new IrisReadResponseError(`IRIS read API returned ${response.status}`, response.status);
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new IrisReadResponseError("IRIS read API returned invalid JSON", response.status);
    }

    assertEnvelope(value);
    return value as T;
  }

  return {
    getBranches: () => get<ReportingEnvelope & { branches: IrisBranch[] }>("branches"),
    getDashboard: (query: { branchId?: string; from?: string; to?: string }) => get<IrisDashboard>("dashboard", query),
    getLiveSnapshot: (branchId: string) => get<IrisLiveSnapshot>(`branches/${encodeURIComponent(branchId)}/live`),
    getAlerts: (query: { branchId?: string; from?: string; to?: string }) => get<IrisAlerts>("alerts", query),
    getEvents: (query: { branchId?: string; from?: string; to?: string; cursor?: string; limit?: number }) =>
      get<IrisEvents>("events", query)
  };
}

function assertEnvelope(value: unknown): asserts value is ReportingEnvelope {
  if (
    !isRecord(value) ||
    typeof value.contractVersion !== "string" ||
    (value.source !== "postgres" && value.source !== "durable-object") ||
    typeof value.fetchedAt !== "string"
  ) {
    throw new IrisReadResponseError("IRIS read API returned an unsupported response contract");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
