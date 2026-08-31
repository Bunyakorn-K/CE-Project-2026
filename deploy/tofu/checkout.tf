# Prerequisites check + repository checkout, run on the target host.
resource "null_resource" "host_prereqs" {
  triggers = { always = timestamp() }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      for cmd in docker git rsync curl; do
        command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not installed on this host"; exit 1; }
      done
      docker info >/dev/null || { echo "ERROR: docker daemon not reachable"; exit 1; }
      if ! grep -q avx2 /proc/cpuinfo 2>/dev/null; then
        echo "NOTE: this CPU has no AVX2 - keep ClickHouse on 26.3 LTS or older."
      fi
    EOT
  }
}

resource "null_resource" "app_checkout" {
  depends_on = [null_resource.host_prereqs]
  triggers = {
    repo    = var.app_repo_url
    ref     = var.app_repo_ref
    app_dir = local.app_dir
  }
  provisioner "local-exec" {
    command = <<-EOT
      set -euo pipefail
      if [ -d "${local.app_dir}/.git" ]; then
        git -C "${local.app_dir}" fetch origin --prune
        git -C "${local.app_dir}" checkout "${var.app_repo_ref}"
        git -C "${local.app_dir}" reset --hard "origin/${var.app_repo_ref}"
      else
        sudo mkdir -p "$(dirname "${local.app_dir}")"
        sudo git clone "${var.app_repo_url}" "${local.app_dir}"
        sudo git -C "${local.app_dir}" checkout "${var.app_repo_ref}"
      fi
      echo "checked out ${var.app_repo_ref} in ${local.app_dir}"
    EOT
  }
}
