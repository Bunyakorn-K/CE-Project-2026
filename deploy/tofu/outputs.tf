output "installed_paths" {
  description = "Where the stacks and env files were installed."
  value = {
    app_dir       = local.app_dir
    analytics_dir = local.analytics_dir
    etl_dir       = local.etl_dir
  }
}

output "local_endpoints" {
  description = "Local ports serving each component (front with a reverse proxy for public access)."
  value = {
    api        = "http://127.0.0.1:8787"
    web        = "http://127.0.0.1:8080"
    playground = "http://127.0.0.1:8082"
    clickhouse = "http://127.0.0.1:8123"
    superset   = "http://127.0.0.1:8088"
    airflow    = "http://127.0.0.1:8081"
    redis      = "analytics-redis-1:6379 (internal)"
  }
}

output "notes" {
  description = "Operational notes for this deployment."
  value = join("\n", [
    "ClickHouse is pinned to 26.3 LTS: 26.6+ requires AVX2 and crashes with SIGILL on CPUs like VM 117 (AMD FX-8350).",
    "Superset metadata DB initializes empty on a fresh host: import/recreate the dashboard, datasets and admin user.",
    "Airflow initializes a fresh metadata DB; the laundrytwin_warehouse_freshness DAG ships in deploy/analytics/dags.",
    "Rollback is: cd into both install dirs, docker compose down, git checkout the previous ref, docker compose up -d.",
  ])
}
