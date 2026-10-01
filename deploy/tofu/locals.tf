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
  # `laundrytwin` with no suffix: it serves the API and the SPA, which are not
  # independently releasable (the web reads fields the API change introduces).
  # The collectors keep their suffixes — they are separate processes on separate
  # schedules and are rolled out on their own cadence.
  app_image     = "${var.registry_url}/laundrytwin:${var.app_image_tag}"
  etl_image     = "${var.registry_url}/laundrytwin-etl:${var.etl_image_tag}"
  weather_image = "${var.registry_url}/laundrytwin-weather:${var.weather_image_tag}"
  gas_image     = "${var.registry_url}/laundrytwin-gas:${var.gas_image_tag}"

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
    APP_IMAGE=${local.app_image}
    ETL_IMAGE=${local.etl_image}
    WEATHER_IMAGE=${local.weather_image}
    ETL_ENV_FILE=${var.etl_env_file}
    WEATHER_ENV_FILE=${var.weather_env_file}
    GAS_IMAGE=${local.gas_image}
    GAS_ENV_FILE=${var.gas_env_file}
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

  # Gas collector: /opt/laundrytwin/gas.env
  # PG_CONNECTION_STRING is deliberately absent for the same reason as weather:
  # this collector reads Home Assistant and ClickHouse, never IRIS Postgres.
  #
  # CLICKHOUSE_USER/PASSWORD here are the WRITE-capable credentials, the same
  # ones etl_env carries — the collector INSERTs, so the reader credential that
  # app_env uses is not sufficient.
  #
  # HA_TOKEN is a real shop credential. It is written here, 0600, and never
  # committed. It has no default in variables.tf, so a missing token fails the
  # plan instead of rendering an empty Bearer that later surfaces as a 401.
  gas_env = trimspace(<<-EOT
    HA_BASE_URL=${var.ha_base_url}
    HA_TOKEN=${var.ha_token}
    GAS_TENANT_ID=${var.gas_tenant_id}
    GAS_BRANCH_ID=${var.gas_branch_id}
    GAS_BRANCH_SLUG=${var.gas_branch_slug}
    GAS_LOOKBACK_HOURS=${var.gas_lookback_hours}
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
  # resolves it with <password from_env=.../>.
  #
  # WARNING: var.clickhouse_reader_password MUST be set to the reader plaintext
  # that is already in use, not a freshly generated value. It is the same secret
  # in three places: this env file, the API container's CLICKHOUSE_PASSWORD
  # (app_env above), and the Caddyfile `basic_auth` for
  # clickhouse.laundrytwin.duckdns.org on the Pi, which holds a bcrypt hash of
  # it. A wrong value renders cleanly, passes `tofu validate`, is accepted by
  # `nullable = false`, and then breaks only the PUBLIC ClickHouse route with a
  # 401 while the API keeps working - a failure that looks like a Caddy problem.
  # Changing it rotates the public credential on both hops and must be done
  # deliberately, with the new hash in the Pi Caddyfile at the same time.
  #
  # Verified 2026-09-30: /opt/analytics/.env does NOT currently carry
  # CLICKHOUSE_READER_PASSWORD (key-name check only, no value read), so this apply
  # ADDS the key and the reader login is not yet driven by it. The hand-written
  # /opt/analytics/clickhouse-reader.local.xml, which holds a literal password no
  # audit or secret scan can see, is the override the deployed host is using while
  # that key is missing - confirm it is still there before removing it. The
  # analytics sync would delete it (`--delete`), and that is gated by
  # deploy/tofu/analytics-delete-allowlist.txt: until the allowlist carries the
  # path, the sync refuses rather than deletes.
  #
  # SUPERSET_DB_PASSWORD is the password of the least-privilege `superset_app`
  # Postgres role that compose.yaml points SUPERSET_DATABASE_URI at. It was
  # already in the live .env while absent from this template, so an apply
  # against the pre-fix locals.tf would have DELETED the key and left Superset
  # unable to reach its own metadata database. It must also be the value
  # already in /opt/analytics/.env - see the warning in variables.tf.
  #
  # Verified 2026-09-30, also by key-name check only: the live
  # /opt/analytics/.env still carries ANALYTICS_READ_API_KEY, which this template
  # does not produce. `install -m 0600` replaces the whole file, so the next apply
  # DELETES that key. Nothing in this repository reads it, and
  # apps/api/src/deploy-config.test.ts fails if it is reintroduced, so the
  # deletion is intended - but it is a real change to a live file, not a no-op.
  analytics_env = trimspace(<<-EOT
    CLICKHOUSE_USER=admin
    CLICKHOUSE_PASSWORD=${var.clickhouse_password}
    CLICKHOUSE_READER_PASSWORD=${var.clickhouse_reader_password}
    AIRFLOW_ADMIN_PASSWORD=${var.airflow_admin_password}
    AIRFLOW_DB_PASSWORD=${var.airflow_db_password}
    SUPERSET_DB_PASSWORD=${var.superset_db_password}
    SUPERSET_SECRET_KEY=${var.superset_secret_key}
  EOT
  )
}
