export class ClickHouseUnavailableError extends Error {}

export type ClickHouseExecutor = <T extends Record<string, unknown>>(
  query: string,
  params?: Record<string, string | number>
) => Promise<T[]>;

export type ClickHouseClientConfig = {
  url?: string;
  user?: string;
  password?: string;
  database?: string;
  fetchImpl?: typeof fetch;
};

export function createClickHouseClient(config: ClickHouseClientConfig = {}): ClickHouseExecutor {
  const url = config.url ?? process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
  const user = config.user ?? process.env.CLICKHOUSE_USER ?? "default";
  const password = config.password ?? process.env.CLICKHOUSE_PASSWORD ?? "";
  const database = config.database ?? process.env.CLICKHOUSE_DATABASE ?? "laundrytwin_analytics";
  const doFetch = config.fetchImpl ?? fetch;

  return async function query<T extends Record<string, unknown>>(queryText: string, params = {}) {
    const search = new URLSearchParams({ database, default_format: "JSONEachRow" });
    for (const [name, value] of Object.entries(params)) search.set(`param_${name}`, String(value));
    let response: Response;
    try {
      response = await doFetch(`${url.replace(/\/$/, "")}/?${search.toString()}`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` },
        body: queryText
      });
    } catch {
      throw new ClickHouseUnavailableError("ClickHouse is unreachable");
    }
    if (!response.ok) {
      throw new ClickHouseUnavailableError(`ClickHouse request failed with status ${response.status}`);
    }
    const text = await response.text();
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  };
}
