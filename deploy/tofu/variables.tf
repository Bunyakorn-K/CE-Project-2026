# Variables for LaundryTwin full-stack provisioning (run tofu ON the target host).
# Never put real secret values here — use a terraform.tfvars file that stays
# untracked (see terraform.tfvars.example) or pass -var/-var-file on the CLI.

variable "app_repo_url" {
  description = "Git remote that contains the application (apps/, Dockerfile, deploy/)."
  type        = string
  default     = "https://github.com/Bunyakorn-K/CE-Project-2026.git"
}

variable "app_repo_ref" {
  description = "Branch or tag to deploy."
  type        = string
  default     = "main"
}

variable "app_install_dir" {
  description = "Where the app repo + compose stack lives on this host."
  type        = string
  default     = "/opt/laundrytwin"
}

variable "analytics_install_dir" {
  description = "Where the analytics compose stack lives on this host."
  type        = string
  default     = "/opt/analytics"
}

variable "etl_data_dir" {
  description = "Host directory holding the ETL watermark + source data."
  type        = string
  default     = "/opt/laundrytwin-etl"
}

# ---------------------------------------------------------------------------
# App .env (/opt/laundrytwin/.env)
# ---------------------------------------------------------------------------

variable "better_auth_secret" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "better_auth_url" {
  description = "Public origin the auth server advertises."
  type        = string
  default     = "https://api.laundrytwin.duckdns.org"
}

variable "cors_origin" {
  type    = string
  default = "https://web.laundrytwin.duckdns.org"
}

variable "line_channel_access_token" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "line_channel_secret" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "laundrytwin_demo_mode" {
  description = "Must stay explicit; never silently enable demo fallback."
  type        = bool
  default     = false
}

variable "mcp_access_token" {
  type      = string
  sensitive = true
  default   = ""
}

variable "mcp_allow_revenue" {
  type    = bool
  default = false
}

variable "bot_model" {
  type    = string
  default = ""
}

variable "bot_mcp_url" {
  type    = string
  default = ""
}

# LINE Login verifies the LIFF ID token against the channel it was issued for.
# Losing this breaks LINE login outright, not just a feature: the server
# rejects every LIFF token. Comma-separated (developing, review, published).
variable "line_login_channel_ids" {
  description = "LINE MINI App channel IDs accepted by LINE Login, comma-separated."
  type        = string
  default     = ""
}

# Legacy single-channel fallback for LINE_LOGIN_CHANNEL_ID. Prefer
# line_login_channel_ids; this only applies when it is the sole value set.
variable "line_login_channel_id" {
  description = "Legacy single LINE Login channel ID. Empty means unset."
  type        = string
  default     = ""
}

# ---------------------------------------------------------------------------
# Container images (deploy/compose.yaml interpolates these)
# ---------------------------------------------------------------------------

variable "registry_url" {
  description = "Internal docker registry the app images are pulled from. Must be host:port without a scheme. The deploy host pulls by this address, so it cannot be 127.0.0.1 unless the daemon resolves it."
  type        = string
  default     = "10.10.0.117:5000"
}

variable "api_image_tag" {
  description = "Tag for laundrytwin-api. Pin an immutable tag (deploy-<sha>-<date>) for a real rollout; 'latest' only suits a fresh host."
  type        = string
  default     = "latest"
}

variable "web_image_tag" {
  type    = string
  default = "latest"
}

variable "etl_image_tag" {
  type    = string
  default = "latest"
}

variable "weather_image_tag" {
  type    = string
  default = "latest"
}

variable "etl_env_file" {
  description = "Host path of the ETL container env file. Kept as a variable because deploy/compose.yaml interpolates it and defaults to the ETL install dir."
  type        = string
  default     = "/opt/laundrytwin-etl/.env"
}

variable "weather_env_file" {
  description = "Host path of the weather container env file. Deliberately NOT the ETL env file: the collector needs TMD_API_KEY and no IRIS Postgres connection string."
  type        = string
  default     = "/opt/laundrytwin/weather.env"
}

variable "clickhouse_url" {
  description = "Native (9000) or HTTP (8123) URL used by api + etl. Same-host compose uses the container name."
  type        = string
  default     = "http://analytics-clickhouse-1:8123"
}

variable "clickhouse_user" {
  type    = string
  default = "admin"
}

variable "clickhouse_password" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "clickhouse_reader_password" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "clickhouse_database" {
  type    = string
  default = "laundrytwin_analytics"
}

# ---------------------------------------------------------------------------
# ETL .env (/opt/laundrytwin-etl/.env) and weather .env (/opt/laundrytwin/weather.env)
# ---------------------------------------------------------------------------

variable "pg_connection_string" {
  description = "Upstream Postgres source for the ETL. Never delivered to the weather collector, which does not read IRIS Postgres."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "tmd_api_key" {
  description = "Thai Meteorological Department API key for the weather collector. The collector throws 'Missing required env var' without it."
  type        = string
  sensitive   = true
  default     = ""
}

variable "etl_watermark_path" {
  type    = string
  default = "/data/watermark.json"
}

variable "etl_since_fallback_days" {
  type    = number
  default = 30
}

variable "etl_usage_batch" {
  type    = number
  default = 5000
}

variable "etl_temperature_batch" {
  type    = number
  default = 50000
}

# ---------------------------------------------------------------------------
# Analytics .env (/opt/analytics/.env)
# ---------------------------------------------------------------------------

variable "airflow_admin_password" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "airflow_db_password" {
  type      = string
  sensitive = true
  nullable  = false
}

variable "superset_secret_key" {
  type      = string
  sensitive = true
  nullable  = false
}

# ---------------------------------------------------------------------------
# Internal docker registry (/srv/registry)
# ---------------------------------------------------------------------------

variable "registry_dir" {
  description = "Where the internal registry's config.yml + htpasswd are installed. Matches deploy/registry/README.md."
  type        = string
  default     = "/srv/registry"
}

variable "registry_htpasswd_entry" {
  description = "Pre-hashed htpasswd line, 'user:hash' (bcrypt). Generated with `docker run --rm httpd:2-alpine htpasswd -nB <user>`, which prompts. A hash is taken rather than a plaintext password so the plaintext never lands in state or on a command line. Empty is rejected by the installer rather than producing an open registry."
  type        = string
  sensitive   = true
  default     = ""
}

# ---------------------------------------------------------------------------
# Web build args
# ---------------------------------------------------------------------------

variable "vite_liff_id" {
  type    = string
  default = ""
}

# The public reverse proxy + TLS is intentionally NOT managed here:
# the home-lab Pi Caddy fronts VM 117 today. On a new host, point any
# reverse proxy at the local ports listed in outputs.tf.
