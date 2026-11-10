# Dependabot: 76 open alerts to 0, and the one the scan could not see

**Date:** 2026-11-10
**Commits:** `0436590` (dependency bumps + overrides), `cea1aa9` (runtime image zod pin)
**Repo:** `Bunyakorn-K/CE-Project-2026`

## What was open

76 alerts, 3 critical, 20 high. Almost all were transitive copies inside
`pnpm-lock.yaml` — the build graph, not the runtime graph.

| severity | count | examples |
|---|---|---|
| critical | 3 | `better-auth` (OAuth state usable as a magic link to sign in as another user), `proxy-addr` (IP spoofing via IPv4-mapped IPv6 trust subnet), `shell-quote` (`quote()` command injection) |
| high | 20 | `axios` ×8, `undici` ×5, `seroval` ×4 (deserialization invoking attacker-chosen callables), `@modelcontextprotocol/sdk` ×4, `vite` ×4, `zod` |
| medium | 40 | `fast-uri` ×5, `ip-address` ×5, `@hono/node-server` ×2, `hono`, `body-parser`, `vite`, `@vitest/mocker` |
| low | 13 | `fast-uri`, `vite`, `@better-auth/*` |

## What changed

**Direct dependencies** (bumped in `apps/*/package.json`):

| package | before | after | note |
|---|---|---|---|
| `better-auth`, `@better-auth/drizzle-adapter` | 1.6.23 | 1.7.19 | the critical one — account takeover |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.32.2 | |
| `hono` | 4.13.7 | 4.13.17 | |
| `@hono/node-server` | 1.19.17 | 2.1.6 | **major**; `serve({ fetch, port })` unchanged for our use |
| `zod` | 4.4.3 | 4.6.7 | |
| `vite` (web) | 7.3.6 | 7.3.7 | |
| `vitest` | 4.1.11 | 4.1.12 | |

**Transitive dependencies** are held by `pnpm.overrides` with range selectors
(`"axios@<1.20.0": "^1.20.0"`), so each pin applies only where a vulnerable
version is actually resolved, and disappears by itself once the parents catch up.
15 added; the existing `qs` entry moved from `<6.16.0` to `<6.16.1`.

## The part that matters

After `0436590`, Dependabot reported **0 open alerts**. The image still shipped a
vulnerable `zod`.

`apps/api/Dockerfile`'s runtime stage has no package manager and no lockfile — it
runs `npm install --no-save` on a hand-written list of the six external runtime
dependencies. So the versions that actually run are the ones typed in that RUN,
and Dependabot reads `pnpm-lock.yaml`. `zod@4.4.3` was pinned there: memory
exhaustion while validating oversized constrained collections, patched in 4.6.6.

Found by asking the container, not the alert list:

```text
/app/node_modules/zod/package.json -> 4.4.3   (dated Nov 9, i.e. the layer was old)
pnpm-lock.yaml                     -> 4.6.7
/app/node_modules/.pnpm            -> absent   (explains the difference: no pnpm here)
```

Two guards now exist so this cannot repeat quietly:

1. `runtime-deps.test.ts` (4 tests) parses the Dockerfile's install block and
   refuses a pin below a known patched floor, and refuses a pin that disagrees
   with the version the lockfile resolved. Runs in CI in about 200ms.
2. The image build asserts the floors against the installed tree and exits 1 —
   the only place that can inspect what actually ships.

## Evidence

```text
Dependabot open alerts (gh api)                0
build / test / check                           pass
tests                                          599 API / 326 web / 117 ETL
local boot of the rebuilt bundle               /health 200 · /api/auth/ok 200 ·
                                               /api/admin/alert-settings 401
production image                               laundrytwin:deploy-cea1aa9-20261110
                                               sha256:2a60ec51…
                                               healthy · health 200 · auth/ok 200
runtime versions inside the container          zod 4.6.7 · ai 7.0.97 ·
                                               better-sqlite3 12.11.1 · undici 7.30.2
GET /api/auth/get-session                      200
POST /api/auth/sign-in/email (junk creds)      401 {"code":"INVALID_EMAIL_OR_PASSWORD"}
GET /alerts/x                                  200 (SPA shell)
```

## Verifying the three things that were left open

### 1. A real sign-in on better-auth 1.7.19 — done, on production

The upgrade crossed a minor that touches session cookies and OAuth state, so
"the endpoints answer" was not enough. A throwaway account was created in the
production database, signed in over HTTPS against the deployed bundle, and deleted
again:

```text
POST /api/auth/sign-in/email  (origin: https://laundrytwin.duckdns.org)
                              200, user.id=verify-login-20261110, token issued
GET  /api/auth/get-session    200, session for that user, expiresAt 2026-11-17
GET  /api/admin/alert-settings  200 (owner-only, so the grant resolved too)
  -> {"settings":{"renotifyHours":12,"monthlyBudget":200,"source":"environment"},
      "usage":{"month":2026-11","used":17,"cap":200,"remaining":183}}
```

The same chain was first run against the built bundle on this machine
(`dist/index.mjs`, same lockfile) to separate a code problem from a production
problem: 200 / 200 / 200 there as well.

Cleanup was verified, not assumed: `sessions 1, account 1, grant 1, user 1`
deleted, then `user 0, account 0, grant 0, session 0`, and the tables back to
`5 users / 4 grants` — the counts they had before the test.

Also learned: the first attempt returned `403 UNTRUSTED_ORIGIN`, because
`trustedOrigins` comes from `CORS_ORIGIN` and defaults to `http://localhost:5173`.
That is the guard working, not a bug, and it is worth knowing before anyone else
tries to script a sign-in.

### 2. The ETL image — rebuilt, deployed, and writing

The ETL was still running an image built five weeks earlier from the internal
registry. The current image (same lockfile as the fix) was pulled by digest,
recreated, and observed:

```text
laundrytwin:etl-9ec6be2-20261110  sha256:90b6db30…  running, restarts=0
ETL phase=schema ok · dim-branch ok · dim-machine ok · usage 1 row ·
temperature 104 rows · "ETL complete" elapsed 299ms
newest row in fact_temperature_sample = 2026-11-09 05:12:24.299
  - exactly the cursor of the cycle that ran after the restart
runtime deps: tsx 4.23.1 · pg 8.23.0 · date-fns 4.4.0 · date-fns-tz 3.2.0
vulnerable packages present: none (checked zod, axios, undici, qs,
  follow-redirects, seroval, fast-uri, ip-address, proxy-addr, shell-quote,
  body-parser)
```

The zero temperature rows inside the last 30 minutes is correct and not a
regression: `temperature_lag_hours=24`, so the cycle writes data timestamped a day
earlier. The table's maximum being exactly the batch cursor is the proof that the
write landed.

### 3. Which alerts could actually reach production — measured

Walking the whole runtime tree of the app container (51 packages, nested
`node_modules` included) and intersecting it with the 22 packages named in the
advisories:

| | count |
|---|---|
| packages in the advisories | 22 |
| present in the runtime image | **2** — `undici@7.30.2` and `zod@4.6.7`, both at or above the patched version |
| absent from the runtime image | 20 — axios, qs, follow-redirects, seroval, fast-uri, ip-address, proxy-addr, shell-quote, body-parser, source-map-js, browserslist, baseline-browser-mapping, vite, vitest, @vitest/mocker, hono, @hono/node-server, @modelcontextprotocol/sdk, better-auth, @better-auth/* |

So the honest summary is: 76 alerts, 2 packages that shipped, 1 of which (`zod`)
was vulnerable until `cea1aa9`. The other 20 were build-time only — which is why
the severity of that list overstated the risk, and why the blind spot was the part
that mattered.

`better-auth` and `hono` are absent from `node_modules` because esbuild bundles
them into `dist/index.mjs`; they ship as code, at the version the lockfile
resolved, which is what the sign-in test in §1 exercised.

## Still open, found while verifying

The release workflow publishes two images — `app` and `etl`. The `weather` and
`gas` collectors are not in the matrix, so they cannot be updated by the pipeline
at all: both are still running `10.10.0.117:5000/laundrytwin-{weather,gas}:latest`
built five weeks ago. They share the ETL image's runtime stage, so their
dependencies are the same clean set — but their code is stale, and nothing will
refresh it. Adding two matrix entries with `target: weather` / `target: gas` is the
fix; it was not done here because rolling out a collector that talks to Home
Assistant and TMD deserves its own check.
