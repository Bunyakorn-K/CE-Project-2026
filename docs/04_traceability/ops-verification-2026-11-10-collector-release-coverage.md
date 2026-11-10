# The collectors had no update path at all

**Date:** 2026-11-10
**Commit:** `9b266ee` (release matrix), images `deploy-9b266ee6…-42761341972`
**Status:** published, deployed, writing data. One gap left, recorded at the end.

## What was wrong

`compose.yaml` runs four services. `.github/workflows/release.yml`'s matrix had
two entries, `app` and `etl`. So `weather` and `gas` had **no way to be updated by
CI at all** — not a slow path, not a manual step, nothing. Both were running
images built by hand on 2026-10-06 into the internal registry:

```text
laundrytwin-gas-1      10.10.0.117:5000/laundrytwin-gas:latest       Up 5 weeks (healthy)
laundrytwin-weather-1  10.10.0.117:5000/laundrytwin-weather:latest   Up 5 weeks (healthy)
```

They report `healthy` the whole time, because the healthcheck is `kill -0 1` —
"the process exists". Five weeks of drift is invisible from the outside.

## The change

`weather` and `gas` are targets of `apps/etl/Dockerfile` (`FROM runtime AS
weather`, `FROM runtime AS gas`), so each became a matrix row:

```yaml
- service: weather
  dockerfile: apps/etl/Dockerfile
  target: weather
- service: gas
  dockerfile: apps/etl/Dockerfile
  target: gas
```

`target` is stated rather than left to the default last-stage rule. That rule holds
only because a comment asks the next editor to keep `etl` last; if the order
changed, a bare build would publish the etl command under the weather tag — a
container that starts, does the wrong thing, and reports healthy. The build step
passes `target: ${{ matrix.target || '' }}`, empty for `app` and `etl` where the
default is correct.

The manual rollout allowlist also refused these two (`expected app or etl`), so a
dispatch naming them would have failed after the build. It now accepts all four.

## The guard

`deploy-config.test.ts` gained three checks derived from the files, not a
checklist: every service in `compose.yaml` appears in the release matrix;
`weather` and `gas` name their own target; the rollout allowlist accepts every
compose service.

Verified by removing the weather row and running the suite:

```text
× publishes an image for every service compose runs
  AssertionError: weather is in compose.yaml but not in the release matrix:
  expected [ 'app', 'etl', 'gas' ] to include 'weather'
× names a build target for services that are not the Dockerfile's last stage
```

Then restored. A guard that has never failed is a guard nobody has checked.

## A second thing found while deploying them

`/opt/laundrytwin/.env` recorded `APP_IMAGE=laundrytwin:deploy-4fb470d-20261109`
— four deploys behind what was actually running (every deploy today passed
`APP_IMAGE=…` on the command line). Any bare `docker compose up -d` would have
rolled the API back to a 2026-11-09 image while looking like a no-op.

The image lines now name what is running, with the previous value kept above each
as a comment, and a backup at `/opt/laundrytwin/.env.bak-20261110-images` (mode
0600, unchanged):

```text
APP_IMAGE=laundrytwin:deploy-cea1aa9-20261110
ETL_IMAGE=laundrytwin:etl-9ec6be2-20261110
WEATHER_IMAGE=laundrytwin:weather-9b266ee-20261110
GAS_IMAGE=laundrytwin:gas-9b266ee-20261110
```

`docker compose config --images` (with `--profile gas`) resolves exactly those
four.

## Evidence

```text
release run 42761602308   Build app ✓  Build etl ✓  Build weather ✓  Build gas ✓
                          (Roll out: skipped — manual only, as designed)
weather digest            sha256:6b9b75cd…
gas digest                sha256:a98db821…
weather after recreate    1 row, newest timestamp 2026-11-10 05:00:00
                          log: {"fetched":1,"rows":1,"branches":["เชียงใหม่"]}
gas after recreate         871 rows over 02:26..05:26 (3 unavailable, kept as NULL)
                          2787 rows in the 4-hour window, newest 05:25:39
containers                laundrytwin-weather-1 / laundrytwin-gas-1 on
                          laundrytwin:weather-9b266ee-20261110 /
                          laundrytwin:gas-9b266ee-20261110
runtime deps              tsx 4.23.1 in both; zero of the 11 vulnerable packages
                          present (same runtime stage as etl)
```

## Still open

- **The tofu path and GHCR do not meet.** `deploy/tofu/locals.tf` builds image
  references as `${var.registry_url}/laundrytwin-weather:${var.weather_image_tag}`
  — the internal registry and the old naming. The pipeline now publishes
  `ghcr.io/bunyakorn-k/ce-project-2026-weather`. Deploying therefore still means
  pull-by-digest and tag locally, then point `*_IMAGE` at the local tag. Making
  `tofu apply -var=weather_image_tag=…` work again needs the locals to take a full
  image reference (or the internal registry to keep receiving pushes). Recorded
  rather than fixed here, because it changes what a rollout means for every
  service, not just these two.
- **The collectors are hourly.** The new images start on recreation and then run
  on their own 300s/3600s loops, so "deployed" is verified by the first cycle plus
  the rows it wrote, not by a request. The gas collector's healthcheck
  (`kill -0 1`) will read `healthy` regardless of whether Home Assistant keeps
  answering — the log line is the real signal.
