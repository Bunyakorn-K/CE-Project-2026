# Env files rendered from variables - OpenTofu interpolates these at apply time.
#
# One env template PER SERVICE, not one shared template. A shared template is
# how a container ends up holding a credential it cannot read: the weather
# collector used to load the ETL env file wholesale, so it carried
# PG_CONNECTION_STRING even though it never touches IRIS Postgres. Each template
# below is checked against the keys that service's own source actually reads by
# apps/api/src/deploy-config.test.ts - adding a key a service cannot read fails
# `pnpm test`.
#
# These templates are rendered with `install -m 0600` over the live files, so a
# key that is missing here is a key that is DELETED on the next apply. Every
# `${VAR}` that deploy/compose.yaml or deploy/analytics/compose.yaml
# interpolates must therefore be produced by exactly one of these templates.
locals {
  app_dir       = var.app_install_dir
  analytics_dir = var.analytics_install_dir
  etl_dir       = var.etl_data_dir

  # Fully-qualified image references. deploy/compose.yaml reads these out of
  # /opt/laundrytwin/.env; without them compose falls back to the bare
  # `laundrytwin-*:latest` defaults, which Docker Hub resolves - and
  # `docker compose pull` then fails or, worse, succeeds against the wrong
  # image.
  api_image     = "${var.registry_url}/laundrytwin-api:${var.api_image_tag}"
  web_image     = "${var.registry_url}/laundrytwin-web:${var.web_image_tag}"
  etl_image     = "${var.registry_url}/laundrytwin-etl:${var.etl_image_tag}"
  weather_image = "${var.registry_url}/laundrytwin-weather:${var.weather_image_tag}"

  # API container: /opt/laundrytwin/.env
  app_env = trimspace(<<-EOT
    NODE_ENV=production
    BETTER_AUTH_SECRET=${var.better_auth_secret}
    BETTER_AUTH_URL=${var.better_auth_url}
    CORS_ORIGIN=${var.cors_origin}
    LINE_CHANNEL_ACCESS_TOKEN=${var.line_channel_access_token}
    LINE_CHANNEL_SECRET=${var.line_channel_secret}
    LINE_LOGIN_CHANNEL_IDS=${var.line_login_channel_ids}
    LINE_LOGIN_CHANNEL_ID=${var.line_login_channel_id}
    LAUNDRYTWIN_DEMO_MODE=${var.laundrytwin_demo_mode ? "true" : "false"}
    LAUNDRYTWIN_DEV_BYPASS=false
    MCP_ACCESS_TOKEN=${var.mcp_access_token}
    MCP_ALLOW_REVENUE=${var.mcp_allow_revenue ? "true" : "false"}
    BOT_MODEL=${var.bot_model}
    BOT_MCP_URL=${var.bot_mcp_url}
    CLICKHOUSE_URL=${var.clickhouse_url}
    CLICKHOUSE_USER=reader
    CLICKHOUSE_PASSWORD=${var.clickhouse_reader_password}
    CLICKHOUSE_DATABASE=${var.clickhouse_database}
    VITE_LIFF_ID=${var.vite_liff_id}
    API_IMAGE=${local.api_image}
    WEB_IMAGE=${local.web_image}
    ETL_IMAGE=${local.etl_image}
    WEATHER_IMAGE=${local.weather_image}
    ETL_ENV_FILE=${var.etl_env_file}
    WEATHER_ENV_FILE=${var.weather_env_file}
  EOT
  )

  # ETL container: /opt/laundrytwin-etl/.env
  # The write-capable ClickHouse credential belongs here and nowhere else.
  etl_env = trimspace(<<-EOT
    PG_CONNECTION_STRING=${var.pg_connection_string}
    CLICKHOUSE_URL=${var.clickhouse_url}
    CLICKHOUSE_USER=${var.clickhouse_user}
    CLICKHOUSE_PASSWORD=${var.clickhouse_password}
    CLICKHOUSE_DATABASE=${var.clickhouse_database}
    ETL_WATERMARK_PATH=${var.etl_watermark_path}
    ETL_SINCE_FALLBACK_DAYS=${var.etl_since_fallback_days}
    ETL_USAGE_BATCH=${var.etl_usage_batch}
    ETL_TEMPERATURE_BATCH=${var.etl_temperature_batch}
  EOT
  )

  # Weather collector: /opt/laundrytwin/weather.env
  # TMD_API_KEY is required (apps/etl/src/weather-run.ts throws without it).
  # PG_CONNECTION_STRING is deliberately absent: the collector reads TMD and
  # ClickHouse, never IRIS Postgres.
  weather_env = trimspace(<<-EOT
    TMD_API_KEY=${var.tmd_api_key}
    CLICKHOUSE_URL=${var.clickhouse_url}
    CLICKHOUSE_USER=${var.clickhouse_user}
    CLICKHOUSE_PASSWORD=${var.clickhouse_password}
    CLICKHOUSE_DATABASE=${var.clickhouse_database}
  EOT
  )

  # Analytics stack: /opt/analytics/.env
  #
  # CLICKHOUSE_PASSWORD here is the *admin* credential: compose.yaml pins
  # CLICKHOUSE_USER=admin on the clickhouse service and
  # clickhouse-admin-networks.xml reads <password from_env="CLICKHOUSE_PASSWORD"/>.
  # Rendering the reader password into this slot would silently repoint the
  # admin login at the reader secret on the next ClickHouse restart, which
  # breaks every ETL write.
  #
  # CLICKHOUSE_READER_PASSWORD must be here too: compose.yaml passes it into
  # the clickhouse container, where the committed clickhouse-reader.xml
  # resolves it with <password from_env=.../>. Omitting it is what forced a
  # hand-written clickhouse-reader.local.xml carrying a literal password into
  # /opt/analytics - a secret in a hand-created file outside git.
  analytics_env = trimspace(<<-EOT
    CLICKHOUSE_USER=admin
    CLICKHOUSE_PASSWORD=${var.clickhouse_password}
    CLICKHOUSE_READER_PASSWORD=${var.clickhouse_reader_password}
    AIRFLOW_ADMIN_PASSWORD=${var.airflow_admin_password}
    AIRFLOW_DB_PASSWORD=${var.airflow_db_password}
    SUPERSET_SECRET_KEY=${var.superset_secret_key}
  EOT
  )
}
