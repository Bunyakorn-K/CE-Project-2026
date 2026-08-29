// Minimal ClickHouse HTTP client (JSONEachRow in, nullable settings out).
// Mirrors the transport used by apps/api/src/analytics/clickhouse.ts so the
// ETL needs no extra SDK: POST the query text with named params as
// param_<name> query-string params, read newline-delimited JSON.

export class ClickHouseError extends Error {
  constructor(message: string, readonly requestId?: string) {
    super(message);
  }
}

export type ClickHouseConfig = {
  url?: string;
  user?: string;
  password?: string;
  database?: string;
  fetchImpl?: typeof fetch;
};

export class ClickHouseClient {
  private readonly base: string;
  private readonly user: string;
  private readonly password: string;
  private readonly database: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ClickHouseConfig = {}) {
    this.base = (config.url ?? process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123").replace(/\/$/, "");
    this.user = config.user ?? process.env.CLICKHOUSE_USER ?? "default";
    this.password = config.password ?? process.env.CLICKHOUSE_PASSWORD ?? "";
    this.database = config.database ?? process.env.CLICKHOUSE_DATABASE ?? "laundrytwin_analytics";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Run a statement (DDL / administrative). Returns response body text. */
  async execute(query: string, settings: Record<string, string> = {}): Promise<string> {
    return this.request(query, settings, undefined, "Text") as Promise<string>;
  }

  /** Run a SELECT and return parsed rows. */
  async query<T = Record<string, unknown>>(sql: string, settings: Record<string, string> = {}): Promise<T[]> {
    return this.request(sql, settings, undefined, "JSONEachRow") as Promise<T[]>;
  }

  /**
   * Insert rows as JSONEachRow. `table` is used only to build a DDL-free
   * INSERT; rows are stringified per line. Named params (if any) are passed
   * so values can be bound without string concatenation.
   */
  async insert<T>(table: string, rows: T[], settings: Record<string, string> = {}): Promise<void> {
    if (rows.length === 0) return;
    const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const sql = `INSERT INTO ${table} FORMAT JSONEachRow`;
    await this.request<string>(sql, settings, body, "Text");
  }

  private async request<T>(
    sql: string,
    settings: Record<string, string>,
    body: string | undefined,
    format: "Text" | "JSONEachRow"
  ): Promise<T | string> {
    const params = new URLSearchParams({ database: this.base ? this.database : this.database });
    params.set("database", this.database);
    if (format === "JSONEachRow") params.set("default_format", "JSONEachRow");
    params.set("query", sql);
    for (const [key, value] of Object.entries(settings)) params.set(key, value);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/?${params.toString()}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.user}:${this.password}`).toString("base64")}`,
          ...(body ? { "Content-Type": "application/x-ndjson" } : {}),
        },
        body,
      });
    } catch (error) {
      throw new ClickHouseError(`ClickHouse unreachable at ${this.base}: ${String(error)}`);
    }
    if (!response.ok) {
      throw new ClickHouseError(`ClickHouse request failed (${response.status}): ${await this.responseText(response)}`);
    }
    const text = await response.text();
    if (format === "JSONEachRow") {
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as T) as T;
    }
    return text as T;
  }

  private async responseText(response: Response): Promise<string> {
    try {
      return (await response.text()).slice(0, 2000);
    } catch {
      return "no body";
    }
  }
}
