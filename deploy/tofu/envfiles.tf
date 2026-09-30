# Env files rendered from tofu variables and installed 0600 - never committed to git.
#
# One file per service. `/opt/laundrytwin/.env` also doubles as the compose
# interpolation file for deploy/compose.yaml, which is why the *_IMAGE keys live
# there; that is compose's design, not a leak, because the web container reads
# no env file at all and the browser is built at image-build time.
resource "local_file" "app_env" {
  content         = local.app_env
  filename        = "${path.module}/rendered/app.env"
  file_permission = "0600"
}

resource "local_file" "etl_env" {
  content         = local.etl_env
  filename        = "${path.module}/rendered/etl.env"
  file_permission = "0600"
}

resource "local_file" "weather_env" {
  content         = local.weather_env
  filename        = "${path.module}/rendered/weather.env"
  file_permission = "0600"
}

resource "local_file" "analytics_env" {
  content         = local.analytics_env
  filename        = "${path.module}/rendered/analytics.env"
  file_permission = "0600"
}

# The registry htpasswd is written straight to its final 0600 path and is never
# staged under rendered/, so a leaked rendered/ directory cannot leak it.
#
# The precondition runs at PLAN time, before anything is installed: an empty
# entry would leave :5000 open to anonymous push and pull, and a plan-time
# failure is a better place to stop than a half-applied stack. The hash is never
# interpolated into a command line either way.
resource "local_sensitive_file" "registry_htpasswd" {
  content              = "${var.registry_htpasswd_entry}\n"
  file_permission      = "0600"
  directory_permission = "0700"
  filename             = "${path.module}/rendered/registry-htpasswd"

  lifecycle {
    precondition {
      condition     = var.registry_htpasswd_entry != ""
      error_message = "registry_htpasswd_entry is empty; refusing to install an unauthenticated registry. Generate one with `docker run --rm httpd:2-alpine htpasswd -nB <user>` and see deploy/registry/README.md."
    }
  }
}

resource "null_resource" "install_envs" {
  depends_on = [
    null_resource.app_checkout,
    local_file.app_env,
    local_file.etl_env,
    local_file.weather_env,
    local_file.analytics_env,
    local_sensitive_file.registry_htpasswd,
  ]
  triggers = {
    app_dir       = local.app_dir
    etl_dir       = local.etl_dir
    analytics_dir = local.analytics_dir
    registry_dir  = var.registry_dir
    repo_ref      = var.app_repo_ref
    # Without this, editing a template rewrites rendered/*.env but never re-runs
    # the `install -m 0600` below, while null_resource.analytics_stack (which
    # hashes the same values) DOES re-run and replaces compose.yaml, so the apply
    # looks successful and the recreated containers read the previous file.
    # Hashed for the same reason as the stack triggers: state gets a digest, not
    # another copy of the plaintext.
    env_hash = sha256("${local.app_env}${local.etl_env}${local.weather_env}${local.analytics_env}")
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      sudo install -m 0600 "${path.module}/rendered/app.env" "${local.app_dir}/.env"
      sudo mkdir -p "${local.etl_dir}/data"
      sudo install -m 0600 "${path.module}/rendered/etl.env" "${local.etl_dir}/.env"
      sudo install -m 0600 "${path.module}/rendered/weather.env" "${local.app_dir}/weather.env"
      sudo install -m 0600 "${path.module}/rendered/analytics.env" "${local.analytics_dir}/.env"

      # Internal registry. The htpasswd is copied from rendered/, never
      # written here, so the hash stays out of the process table. The
      # precondition on local_sensitive_file.registry_htpasswd has already
      # refused an empty entry by the time this runs.
      sudo mkdir -p "${var.registry_dir}"
      sudo install -m 0644 "${local.app_dir}/deploy/registry/config.yml" "${var.registry_dir}/config.yml"
      sudo install -m 0644 "${local.app_dir}/deploy/registry/compose.yaml" "${var.registry_dir}/compose.yaml"
      sudo install -m 0600 "${path.module}/rendered/registry-htpasswd" "${var.registry_dir}/htpasswd"
      echo "env files + registry config installed"
    EOT
  }
}
