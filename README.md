# LaundryGo

LaundryGo is a standalone, mobile-first LINE LIFF reporting surface for
laundromat stakeholders. It reads tenant-scoped reporting data through the
IRIS LaundryGo Read API and keeps its own local access control, alert
acknowledgement audit trail, and admin workflow.

It never sends machine commands, writes payment data, ingests telemetry, or
exposes IRIS credentials to the browser.

## Architecture

```text
LINE LIFF or local owner account
              |
              v
    LaundryGo React mobile web
              |
              v
    LaundryGo Hono API + local SQLite
              |
              | X-LaundryGo-Read-Key (server only)
              v
    IRIS /v1/laundrygo read API
              |
              v
       IRIS reporting and live state
```

## Run locally

1. Use Node.js 22+ and pnpm 10+.
2. Copy `.env.example` to `.env`.
3. Set a unique `BETTER_AUTH_SECRET` and a `LAUNDRYGO_BOOTSTRAP_ADMIN_EMAIL`.
4. Configure `IRIS_READ_BASE_URL` and `IRIS_LAUNDRYGO_READ_API_KEY` once the
   corresponding IRIS Worker integration is available.
5. Run `pnpm install` and `pnpm dev`.

The mobile app is at `http://localhost:5173`; the API is at
`http://localhost:8787`. The Vite development server proxies `/api` requests
to the Hono API.

Without the two IRIS read settings, authenticated users see an explicit
reporting-source-unavailable state. LaundryGo does not create fallback metrics
or fabricated machine statuses.

## Demo mode

Set `LAUNDRYGO_DEMO_MODE=true` only for local preview or stakeholder demo.
LaundryGo then shows a labeled `DEMO MODE` entry point, simulated branches,
machine states, alerts, and a local Demo Owner session. It makes no IRIS request
and is never an automatic fallback when real reporting is unavailable.

## Access workflow

1. Create or sign in to the local owner account using the bootstrap email.
2. Open `/mange` to review LINE access requests and active grants.
3. A LINE user opens the LIFF app. Their ID token is verified server-side and
   an unknown user creates a pending local access request.
4. An owner approves the request as `owner`, `manager`, or `technician`.
5. The user reopens LIFF and receives a short-lived, HttpOnly LaundryGo
   session cookie.

Role scope:

| Role | Branch scope | Revenue | Access administration |
| --- | --- | --- | --- |
| Owner | All branches in the configured IRIS tenant | Yes | Yes |
| Manager | One assigned branch per grant | Yes | No |
| Technician | One assigned branch per grant | No | No |

Alert acknowledgement is local to LaundryGo and audit-logged. It never marks
an IRIS alert as acknowledged upstream.

## LINE configuration

Set `VITE_LIFF_ID` for the browser and `LINE_LOGIN_CHANNEL_ID` for the Hono
API. The latter is used only to verify an ID token with LINE. The LIFF ID is
public; channel secrets, access tokens, the IRIS read key, and Better Auth
secret remain server-side.

`POST /webhooks/line` is optional and remains disabled until both LINE Messaging
API variables are configured. It is not required for LIFF sign-in.

## Production configuration

Copy `deploy/.env.production.example` to `.env` on the VM and set every value
needed by the chosen features. `docker compose up -d --build` runs the Hono API
and Nginx web container. The `VITE_LIFF_ID` build argument is intentionally the
only browser-exposed build setting; the IRIS key is available only to the API
container.

Back up `data/laundrygo.sqlite` before replacing the VM or recreating its
persistent volume.

## Verification commands

- `pnpm test` — API and web unit tests.
- `pnpm check` — TypeScript checks for both workspaces.
- `pnpm build` — API type check and production Vite build.

## IRIS integration contract

LaundryGo expects the versioned endpoints summarized in
[`docs/integration/iris-laundrygo-read-api.md`](docs/integration/iris-laundrygo-read-api.md).
The backend holds the integration key and sends it through
`X-LaundryGo-Read-Key`; there is no tenant, arbitrary URL, or credential input
in the browser request path.
