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

## What is not verified

- **Login as a real user.** `better-auth` went from 1.6 to 1.7, which touches
  session cookies and the OAuth state handling that the critical advisory was
  about. The endpoints behave (`get-session` 200, bad credentials 401 with the
  normal error shape), but a successful sign-in with a real account has not been
  performed since the upgrade. That is the one check left, and it needs a human.
- **The ETL container.** Its image is built from the same lockfile, so the
  transitive bumps apply, but no ETL image was rebuilt or deployed here.
- Of the 76 alerts, most were never reachable in production: the runtime tree is
  six packages plus what npm resolves for them. `zod` and `undici` were the two
  that shipped; `undici` was already patched at build time (7.30.2), `zod` was not.
