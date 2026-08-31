# Env files rendered from variables - OpenTofu interpolates these at apply time.
locals {
  app_dir       = var.app_install_dir
  analytics_dir = var.analytics_install_dir
  etl_dir       = var.etl_data_dir

  app_env = trimspace(<<-EOT
    NODE_ENV=production
    BETTER_AUTH_SECRET=${var.better_auth_secret}
    BETTER_AUTH_URL=${var.better_auth_url}
    CORS_ORIGIN=${var.cors_origin}
    LINE_CHANNEL_ACCESS_TOKEN=${var.line_channel_access_token}
    LINE_CHANNEL_SECRET=${var.line_channel_secret}
    LAUNDRYTWIN_DEMO_MODE=${var.laundrytwin_demo_mode ? "true" : "false"}
    ANALYTICS_READ_API_KEY=${var.analytics_read_api_key}
    MCP_ACCESS_TOKEN=${var.mcp_access_token}
    MCP_ALLOW_REVENUE=${var.mcp_allow_revenue ? "true" : "false"}
    OPENROUTER_API_KEY=${var.openrouter_api_key}
    BOT_MODEL=${var.bot_model}
    BOT_MCP_URL=${var.bot_mcp_url}
    CLICKHOUSE_URL=${var.clickhouse_url}
    CLICKHOUSE_USER=${var.clickhouse_user}
    CLICKHOUSE_PASSWORD=${var.clickhouse_password}
    CLICKHOUSE_DATABASE=${var.clickhouse_database}
    VITE_LIFF_ID=${var.vite_liff_id}
  EOT
  )

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

  analytics_env = trimspace(<<-EOT
    CLICKHOUSE_PASSWORD=${var.clickhouse_password}
    AIRFLOW_ADMIN_PASSWORD=${var.airflow_admin_password}
    SUPERSET_SECRET_KEY=${var.superset_secret_key}
    ANALYTICS_READ_API_KEY=${var.analytics_read_api_key}
  EOT
  )
}
