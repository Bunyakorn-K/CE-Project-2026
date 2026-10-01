# Analytics stack: rsync repo deploy/analytics to the install dir, build, up.
resource "null_resource" "analytics_stack" {
  depends_on = [null_resource.install_envs]
  triggers = {
    ref           = var.app_repo_ref
    analytics_dir = local.analytics_dir
    compose_hash  = filemd5("${path.module}/../analytics/compose.yaml")
    # A new analytics credential (e.g. a rotated reader password) must
    # recreate the containers that consume it. Hashed so the trigger value in
    # state is a digest rather than another copy of the plaintext.
    env_hash = sha256(local.analytics_env)
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      # --delete makes /opt/analytics a clone of the repo, so the sync prints a
      # full itemised dry-run diff and refuses to run unless every path it would
      # delete is listed in the committed allowlist. `set -e` above means a
      # refusal aborts here, before the .env is installed and before
      # `docker compose up -d`, so nothing is changed by a refused apply.
      # Read the printed diff; it is the list of what the apply loses.
      sudo bash "${path.module}/scripts/analytics-rsync.sh" \
        "${local.app_dir}/deploy/analytics/" "${local.analytics_dir}/" \
        "${path.module}/analytics-rsync.excludes" "${path.module}/analytics-delete-allowlist.txt"
      sudo install -m 0600 "${path.module}/rendered/analytics.env" "${local.analytics_dir}/.env"
      cd "${local.analytics_dir}"
      sudo docker compose pull --ignore-pull-failures 2>/dev/null || true
      sudo docker compose build superset
      sudo docker compose up -d
      echo "analytics stack up"
    EOT
  }
  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      if [ -f "${self.triggers.analytics_dir}/compose.yaml" ]; then
        cd "${self.triggers.analytics_dir}"
        sudo docker compose down || true
      fi
    EOT
  }
}

# App stack: the merged `laundrytwin` image (API + SPA in one container) plus
# the etl and weather collectors, pulled from the internal registry
# (10.10.0.117:5000). The api and web Dockerfiles were one file before the
# merge; app_docker hashes the single one that now builds both halves, so a
# change to either rebuilds and re-pulls the image that carries them.
resource "null_resource" "app_stack" {
  depends_on = [null_resource.install_envs, null_resource.analytics_stack]
  triggers = {
    ref        = var.app_repo_ref
    app_dir    = local.app_dir
    app_docker = filemd5("${path.module}/../../apps/api/Dockerfile")
    etl_docker = filemd5("${path.module}/../../apps/etl/Dockerfile")
    compose    = filemd5("${path.module}/../../compose.yaml")
    # Without this, moving var.app_image_tag (or any env value) rewrites the
    # .env files but leaves the containers on their old image - the *_IMAGE
    # keys would be delivered and then ignored. Hashed for the same reason as
    # the analytics trigger above.
    env_hash = sha256("${local.app_env}${local.etl_env}${local.weather_env}")
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      cd "${local.app_dir}"
      sudo docker compose pull app etl weather
      sudo docker compose up -d
      echo "app stack up"
    EOT
  }
  provisioner "local-exec" {
    when    = destroy
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
      check app_health http://127.0.0.1:8787/health 200
      # The SPA and the API are one container on one port now, so these three
      # are the merge's own smoke: a 200 on /health alone would pass with the
      # static half missing, which is the failure this change could introduce.
      # /playground is a client-side route with no extension — it 200s only if
      # the SPA fallback resolves it to index.html rather than 404ing.
      check app_root   http://127.0.0.1:8787/          200
      check app_spa_route http://127.0.0.1:8787/playground 200
      # A server path must NOT be answered with the SPA. 404 is correct: it
      # proves the fallback did not swallow a mistyped API route, which would
      # otherwise reach the browser as 200-with-HTML and map to no error code.
      check app_api_404 http://127.0.0.1:8787/api/__smoke__ 404
      check clickhouse http://127.0.0.1:8123/ping    200
      check airflow    http://127.0.0.1:8081/api/v2/monitor/health 200
      check superset   http://127.0.0.1:8088/health  200
      # 401, not 200: an unauthenticated registry answers 200 and accepts
      # anonymous push, so this is the check that catches removed htpasswd auth.
      check registry_auth http://127.0.0.1:5000/v2/ 401
      if [ "$fail" -ne 0 ]; then exit 1; fi
      echo "ALL SMOKE OK"
    EOT
  }
}
