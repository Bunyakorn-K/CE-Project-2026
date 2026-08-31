# Env files rendered from tofu variables and installed 0600 - never committed to git.
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

resource "local_file" "analytics_env" {
  content         = local.analytics_env
  filename        = "${path.module}/rendered/analytics.env"
  file_permission = "0600"
}

resource "null_resource" "install_envs" {
  depends_on = [null_resource.app_checkout, local_file.app_env, local_file.etl_env, local_file.analytics_env]
  triggers = {
    app_dir       = local.app_dir
    etl_dir       = local.etl_dir
    analytics_dir = local.analytics_dir
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      sudo install -m 0600 "${path.module}/rendered/app.env" "${local.app_dir}/.env"
      sudo mkdir -p "${local.etl_dir}/data"
      sudo install -m 0600 "${path.module}/rendered/etl.env" "${local.etl_dir}/.env"
      sudo install -m 0600 "${path.module}/rendered/analytics.env" "${local.analytics_dir}/.env"
      echo "env files installed"
    EOT
  }
}
