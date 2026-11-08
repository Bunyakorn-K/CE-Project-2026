# Sign-out holds — production verification (2026-11-09)

**Status: PASS, deployed as `laundrytwin:deploy-4fb470d-20261109` (commit
`4fb470d`).** The defect recorded on 2026-11-08 — sign-out revoking both sessions
and the gate re-authenticating 0.58 s later — is closed, measured on the same
device with the same method. Two assertions folded into one run: `GET /api/me`
answers **401** after the sign-out, and **no** `POST /api/auth/liff/exchange`
happens on the load that follows it.

Plan: `docs/superpowers/plans/2026-11-08-sign-out-reauthentication-defect.md`
(Tasks 5–6). Defect record:
`docs/04_traceability/ops-verification-2026-11-07-line-redirect-signout-production.md`.

## Before / after, same device, same measurement

Real LINE app on Android (emulator `ltline`, Pixel 6, API 35) driving production
in Android Chrome `124.0.6367.219` over CDP `Network.*`. No seeded session, no
credential handled by the agent.

| | Before (`deploy-ffa4e15-20261002`) | After (`deploy-4fb470d-20261109`) |
|---|---|---|
| Press | `18:22:34Z` | `18:51:03Z` |
| `POST /api/auth/sign-out` | 200, `ct=application/json` | 200, `ct=application/json` |
| `POST /api/auth/liff/logout` | 200 | 200 |
| `POST /api/auth/liff/exchange` | **200 at +0.58 s** | **absent** |
| `GET /api/me` | **200** | **401** (at +2.53 s) |
| Visible route | `/dashboard` | `/login`, sign-in form |
| `localStorage.liff_signed_out` | — | `"1"` |

After-trace, verbatim:

```
2.09s REQ POST /api/auth/sign-out      ct=application/json
2.09s REQ POST /api/auth/liff/logout   ct=-
2.13s RES 200 /api/auth/sign-out type=application/json
2.13s RES 200 /api/auth/liff/logout type=application/json
2.51s REQ GET  /api/me
2.53s RES 401 /api/me type=application/json
```

### The load the defect lived on

The defect was not the absence of a revocation — it was the full page load the
sign-out performs. So that load was measured separately, signed out, marker set:

- Reload of `/login` at `18:51:30Z`: the resource timeline contains exactly
  `["/api/me"]` and `some(/api/auth/liff/exchange)` is **false**; `liff_signed_out`
  is still `"1"`; `/api/me` **401**. Repeated reload, same result.
- `liff.logout()` also dropped the cached token: after the sign-out the store
  holds only `LIFF_STORE:…:context` and the login guard — no `accessToken`, no
  `IDToken`.

### Sign-in still works, in one press

From the signed-out state at `18:52:06Z`, one press of "เข้าสู่ระบบด้วย LINE":
`/dashboard`, `GET /api/me` **200**, KPI rendered from ClickHouse
(`3 พ.ย. 2569 — 9 พ.ย. 2569`, `ดึงเมื่อ 9 พ.ย. 01:52`), `liff_signed_out` cleared
to `null`, and the exchange request present. The marker is cleared by the press
(`signInWithLiff`), not by the page load — which is the whole fix.

### Legal documents in the same session

`/privacy` at `18:50:45Z` and `/terms` at `18:50:51Z` both stayed on the document
while signed in; neither redirected.

## Deploy record

| Step | Measured |
|---|---|
| Baseline | app `deploy-ffa4e15-20261002`, up 32 h healthy; `/health` 200 JSON, `/` `/login` `/privacy` `/terms` `/playground` 200 HTML, `/api/me` 401, `/api/__smoke__` 404, `POST /nope` 404, traversal 404 |
| SQLite backup | `db.backup()` inside the container → `/data/backup-pre-signoutfix-20261108T184619Z.sqlite`, **229,376 bytes**, `integrity_check: ok`, **15** tables, **5** users, **4** `access_grant`, **6** `session`. The main file is a 4 KB stub against its WAL, so `cp` would have captured nothing |
| `.env` backup | `/opt/laundrytwin/.env.bak-20261109-pre-signoutfix` |
| Image | `laundrytwin:deploy-4fb470d-20261109`, `linux/amd64`, built in 48 s from repo root with `--build-arg VITE_LIFF_ID=2011592166-uToRdTwS`. Verified **by running it before it was loaded**: the image's own `/app/public/assets` carry `liff_signed_out` and the ordered sign-out sequence |
| Transfer | `docker save \| gzip -1 \| ssh … \| docker load`, 32 s. Image ID differs after load (save/load does not preserve it) — **all 8 RootFS layer digests match exactly**, which is the check that matters |
| Roll | `APP_IMAGE=laundrytwin:deploy-4fb470d-20261109  # rollback: laundrytwin:deploy-ffa4e15-20261002`, then `docker compose up -d app` |
| Caddy | **Not touched.** The port does not move, so no recreate across the other hostnames Caddy serves |
| Container | `laundrytwin-app-1` **0 restarts**, healthy, started `18:48:44Z`. ETL, gas and weather untouched (`Up 4 weeks`) |
| Bundle | `index-BGIBi0Rb.js` → **`index-dD3HfW6M.js`**, the only intended change |
| Shipped bytes | Publicly served `index-dD3HfW6M.js` carries `liff_signed_out` and `localStorage.setItem(…,"1")`; served `_authenticated-Crig-UpS.js` carries `Promise.allSettled([e.requestSignOut(),e.requestLiffLogout()]),g(),e.dropLiffToken(),e.clearClientSession(),e.replace("/login")` |

Note for the next deploy: a local `pnpm build` without `VITE_LIFF_ID` strips the
LIFF branches, so its chunk hashes differ from the Docker image's. The image is
the artifact to grep, not `apps/web/dist`.

**Rollback:** set `APP_IMAGE=laundrytwin:deploy-ffa4e15-20261002` in
`/opt/laundrytwin/.env` and `docker compose up -d app`. The rollback image is
still on the VM. **Rolling back restores the defect.**

## What this does NOT establish

- **Not the LIFF-browser press.** The flow ran in Android Chrome with the LINE app
  installed. `liff.login()` cannot be used inside a real LIFF browser, so that leg
  remains unreachable by construction and is not claimed.
- **Not a real expired token.** Still unreproducible: the SDK validates its cached
  token against LINE's servers and discards a seeded store.
- **One device, one browser build.** Android 15 / Chrome 124 / LINE 26.17.1.
- **Not the shared-machine case in full.** The marker holds across reloads and in
  the same tab; a second tab opened *before* the sign-out was not re-tested.
- Not the narrow-grant path — unchanged, still unit-only (2026-11-06 audit).

## Cleanup

Cookies and origin storage cleared over CDP after the run (`/api/me` → 401,
`localStorage` empty), extra tabs closed. The emulator still holds the owner's own
LINE login; no test account was created — the session was the ordinary
LINE-sourced account the app creates for itself. No secret was printed or
committed.
