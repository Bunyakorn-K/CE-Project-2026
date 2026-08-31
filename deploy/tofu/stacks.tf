# Analytics stack: rsync repo deploy/analytics to the install dir, build, up.
resource "null_resource" "analytics_stack" {
  depends_on = [null_resource.install_envs]
  triggers = {
    ref           = var.app_repo_ref
    analytics_dir = local.analytics_dir
    compose_hash  = filemd5("${path.module}/../analytics/compose.yaml")
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      sudo rsync -a --delete --exclude ".env" --exclude "*.before-*" --exclude "dags-disabled" \
        "${local.app_dir}/deploy/analytics/" "${local.analytics_dir}/"
      sudo install -m 0600 "${path.module}/rendered/analytics.env" "${local.analytics_dir}/.env"
      cd "${local.analytics_dir}"
      sudo docker compose pull --ignore-pull-failures 2>/dev/null || true
      sudo docker compose build superset
      sudo docker compose up -d
      echo "analytics stack up"
    EOT
  }
  provisioner "local-exec" {
    when = destroy
    command = <<-EOT
      if [ -f "${self.triggers.analytics_dir}/compose.yaml" ]; then
        cd "${self.triggers.analytics_dir}"
        sudo docker compose down || true
      fi
    EOT
  }
}

# App stack: api/web/playground/etl built from the repo root Dockerfile + compose.
resource "null_resource" "app_stack" {
  depends_on = [null_resource.install_envs, null_resource.analytics_stack]
  triggers = {
    ref        = var.app_repo_ref
    app_dir    = local.app_dir
    dockerfile = filemd5("${path.module}/../../Dockerfile")
    compose    = filemd5("${path.module}/../../compose.yaml")
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      cd "${local.app_dir}"
      sudo docker compose build
      sudo docker compose up -d
      echo "app stack up"
    EOT
  }
  provisioner "local-exec" {
    when = destroy
    command = <<-EOT
      if [ -f "${self.triggers.app_dir}/compose.yaml" ]; then
        cd "${self.triggers.app_dir}"
        sudo docker compose down || true
      fi
    EOT
  }
}

# Post-apply smoke checks over local ports (mirrors the VM smoke set).
resource "null_resource" "smoke" {
  depends_on = [null_resource.app_stack, null_resource.analytics_stack]
  triggers   = { always = timestamp() }
  provisioner "local-exec" {
    command = <<-EOT
      set -uo pipefail
      fail=0
      check() {
        name="$1" url="$2" want="$3"
        code=$(curl -s -o /dev/null -m 15 -w "%$${http_code}" "$url" || echo 000)
        if [ "$code" != "$want" ]; then
          echo "SMOKE FAIL: $name -> $code (want $want)"
          fail=1
        else
          echo "SMOKE OK: $name -> $code"
        fi
      }
      check api        http://127.0.0.1:8787/health 200
      check web        http://127.0.0.1:8080/        200
      check playground http://127.0.0.1:8082/        200
      check clickhouse http://127.0.0.1:8123/ping    200
      check airflow    http://127.0.0.1:8081/api/v2/monitor/health 200
      check superset   http://127.0.0.1:8088/health  200
      if [ "$fail" -ne 0 ]; then exit 1; fi
      echo "ALL SMOKE OK"
    EOT
  }
}
