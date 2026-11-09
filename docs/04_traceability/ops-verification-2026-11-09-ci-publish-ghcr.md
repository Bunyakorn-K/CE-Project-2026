# CI publishes to GHCR now — and refuses to publish a LINE-less image

**Date:** 2026-11-09
**File:** `.github/workflows/release.yml`
**Status: workflow changed, CI green, publish still blocked — on one secret, not
three.**

## What changed, and why

The publish half could never be configured from GitHub alone: the internal
registry at `registry.laundrytwin.duckdns.org` authenticates with an htpasswd
credential that exists only on the VM, so `REGISTRY_USER` and
`REGISTRY_PASSWORD` had to be pasted into GitHub from a host-side secret. GHCR
removes that: the workflow logs in with its own `GITHUB_TOKEN` and
`permissions: packages: write`.

| | before | after |
|---|---|---|
| registry | `registry.laundrytwin.duckdns.org` | `ghcr.io` |
| auth | `REGISTRY_USER` + `REGISTRY_PASSWORD` secrets | the run's `GITHUB_TOKEN` |
| image | `<registry>/laundrytwin-app:<tag>` | `ghcr.io/bunyakorn-k/ce-project-2026-app:<tag>` |
| secrets needed | 3 | **1** (`VITE_LIFF_ID`) |

## Three details that would each have failed silently

1. **The path must be lowercase.** `github.repository` is
   `Bunyakorn-K/CE-Project-2026` and Docker rejects an uppercase path component,
   so the build job derives `${GITHUB_REPOSITORY,,}`.
2. **The derived name is a step OUTPUT, not a `GITHUB_ENV` write.** `${{ env.X }}`
   is evaluated from the workflow's static env context; a runtime `GITHUB_ENV`
   write reaches later *shells* but renders **empty** inside `with:`. The first
   draft used `env.IMAGE_NAME` and would have pushed to `ghcr.io/-app:…`, failing
   only at push time.
3. **A build without `VITE_LIFF_ID` is refused before it is pushed.** Without it
   every LINE LIFF branch is compiled out of the SPA — the same condition that
   skips the Playwright specs — so the image could not sign anyone in with LINE
   while wearing a deploy tag that looks exactly like a good one.

## Verified

```text
CI on the pushed head   42591725421   success   2m46s   2026-11-09 09:13:24Z
Release (workflow_run)  42592093695   failure   17s     2026-11-09 09:16:13Z
  Build app  → Refuse to publish an image without the LIFF ID
  Build etl  → Refuse to publish an image without the LIFF ID
```

The failure is the guard doing its job: `VITE_LIFF_ID` is not configured, and
`gh secret list` still returns nothing. **No image has been published by CI**,
and the `production` environment still does not exist
(`gh api …/environments` → `total_count: 0`).

## What the human has to do

```bash
gh secret set VITE_LIFF_ID        # = 2011592166-uToRdTwS, read out of the served bundle
gh api -X PUT repos/Bunyakorn-K/CE-Project-2026/environments/production
```

Both need repository admin; the agent's token answers `403 Must have admin
rights` on the second. After that the release publishes two images (`app`,
`etl`) and the run summary records their digests.

## Not verified, and a host-side consequence

- **The GHCR push itself is unverified** — nothing has got past the LIFF guard,
  so the login and the push have never run. That is the next thing to check when
  the secret exists.
- **A GHCR package is private by default even for a public repository.** The VM
  must either hold a `docker login ghcr.io` credential (`read:packages`) or the
  package must be made public, or `docker compose pull` on the host answers
  `unauthorized`. This is recorded in `docs/02_architecture/deploy-runbook.md`
  because it is a host-side fact the workflow cannot assert.
- The internal registry is unchanged and still serves images built on the Mac.
  Nothing in this change touches a running container.
