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
    web        = "http://127.0.0.1:8080 (includes /playground)"
    clickhouse = "http://127.0.0.1:8123"
    superset   = "http://127.0.0.1:8088"
    airflow    = "http://127.0.0.1:8081"
    redis      = "analytics-redis-1:6379 (internal)"
  }
}

output "env_files" {
  description = "Which env file each container receives. One file per service: no file is fanned out to a container that cannot read it."
  value = {
    api       = "${local.app_dir}/.env"
    web       = "(none - no env file; VITE_* values are baked at image build time)"
    etl       = var.etl_env_file
    weather   = var.weather_env_file
    analytics = "${local.analytics_dir}/.env"
  }
}

output "images" {
  description = "Image references written to /opt/laundrytwin/.env and pulled by deploy/compose.yaml."
  value = {
    app     = local.app_image
    etl     = local.etl_image
    weather = local.weather_image
  }
}

output "notes" {
  description = "Operational notes for this deployment."
  value = join("\n", [
    "ClickHouse is pinned to 26.3 LTS: 26.6+ requires AVX2 and crashes with SIGILL on CPUs like VM 117 (AMD FX-8350).",
    "The analytics stack is synced from the CHECKED-OUT repo tree (app_checkout does fetch + checkout + reset --hard origin/${var.app_repo_ref}), never from a local working tree. Changes that are not merged AND pushed are inert here, and an apply run with a branch name instead of a commit sha re-deploys whatever the branch last pointed at. Review the rsync deletion gate's dry-run diff against post-merge origin/main.",
    "The analytics sync refuses to delete any path not listed in analytics-delete-allowlist.txt. That list is empty on purpose: expect the first real apply to stop there, print the paths it wanted to delete, and be reviewed before any line is added.",
    "clickhouse_reader_password and superset_db_password must be the values ALREADY in use (Pi Caddyfile basic_auth hash; existing superset_app role). This apply delivers them, it does not rotate the underlying credential.",
    "/opt/analytics/.env is replaced with install -m 0600, so a key missing from locals.tf is a key the apply deletes. ANALYTICS_READ_API_KEY is still on the live file and no code path reads it, so the first apply drops it.",
    "Superset metadata DB starts empty on a fresh host and nothing in this repository creates the `superset` database or the `superset_app` role: create both by hand, then run bootstrap-superset.sh.",
    "Airflow initializes a fresh metadata DB; the laundrytwin_warehouse_freshness DAG ships in deploy/analytics/dags.",
    "Rollback is: cd into both install dirs, docker compose down, git checkout the previous ref, docker compose up -d.",
    "The registry files in ${var.registry_dir} are installed but the container is NOT started or recreated by tofu, so an apply cannot interrupt a running deploy path. Start it with: docker compose -f ${var.registry_dir}/compose.yaml up -d",
    "The registry smoke check expects 401 on /v2/. A 200 means htpasswd auth is gone and anyone who can reach :5000 can push.",
  ])
}
