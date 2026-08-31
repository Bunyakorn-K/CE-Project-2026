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

variable "analytics_read_api_key" {
  type      = string
  sensitive = true
  nullable  = false
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

variable "openrouter_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "bot_model" {
  type    = string
  default = ""
}

variable "bot_mcp_url" {
  type    = string
  default = ""
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

variable "clickhouse_database" {
  type    = string
  default = "laundrytwin_analytics"
}

# ---------------------------------------------------------------------------
# ETL .env (/opt/laundrytwin-etl/.env)
# ---------------------------------------------------------------------------

variable "pg_connection_string" {
  description = "Upstream Postgres source for the ETL."
  type        = string
  sensitive   = true
  nullable    = false
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

variable "superset_secret_key" {
  type      = string
  sensitive = true
  nullable  = false
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
