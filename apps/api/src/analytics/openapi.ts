export const ANALYTICS_PATHS: { path: string; method: "get"; summary: string }[] = [];

export function registerPath(entry: { path: string; method: "get"; summary: string }) {
  ANALYTICS_PATHS.push(entry);
}

export function buildOpenApiDocument() {
  return {
    openapi: "3.0.3",
    info: {
      title: "LaundryTwin Analytics API",
      version: "1.0.0",
      description:
        "Allow-listed analytics endpoints over ClickHouse. Session cookie required (Better Auth, LIFF, or demo session). Revenue endpoints require owner/manager."
    },
    paths: Object.fromEntries(
      ANALYTICS_PATHS.map((entry) => [
        entry.path,
        { [entry.method]: { summary: entry.summary, responses: { "200": { description: "Analytics envelope" } } } }
      ])
    )
  };
}
