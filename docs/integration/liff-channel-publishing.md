# LINE: why an ordinary user cannot get in, and what to change

**Symptom:** opening the LIFF URL shows LINE's own page —

> 400 Bad Request
> This channel is now developing status. User need to have developer role.

The app never loads, so nothing in our code is involved. LINE refuses the login before
the LIFF endpoint is reached.

## What the message actually means

The channel that owns the LIFF app is **not published**. In that state LINE only lets
in people who hold a developer/admin role on that channel in the LINE Developers
Console. Everyone else is refused at the authorize step, with this exact text.

It is a channel-status problem, not a choice between "LINE MINI App" and "LIFF". A
LIFF app added to an unpublished channel behaves the same way.

## Which channel is it

The LIFF ID in production is `2011592166-uToRdTwS`. The number before the dash is the
channel id. Open LINE Developers Console → the provider → that channel, and read the
**channel type**:

| channel type | publishing |
|---|---|
| **LINE MINI App** | needs a release request and LINE's review (days) |
| **LINE Login** (with a LIFF app) | "Publish" in the console, effective immediately |

This is the whole decision: if the channel is a MINI App, switching to a LINE Login
channel is faster than waiting for the review — the app itself does not care which one
it runs on.

## Two ways forward

### A. Keep the channel, unblock testing now

Add the person as a **Tester** (MINI App channels) or to the channel's **developer
role** (LINE Login channels). They can then use it; nobody else can. This is not a
release.

### B. Move to a LINE Login channel (no review)

1. Console → **Create a new channel → LINE Login**.
2. In that channel → **LIFF** tab → **Add LIFF app**:
   - Endpoint URL: `https://laundrytwin.duckdns.org`
   - Size: Full
   - Scopes: `profile`, `openid` (add `email` only if the app will read the address)
   - Options: scan QR on, and — importantly — **`openid` is what lets the server verify
     the ID token**, which is how sign-in works here.
3. **Publish** the LINE Login channel.
4. Copy the new LIFF ID (`1234567890-AbCdEfGh`).

## What changes in this repository when the LIFF ID changes

No code — but **four** values, not two, and the one people forget is the one that
breaks sign-in *after* every visible step looks right.

| value | where | why it matters | who |
|---|---|---|---|
| `LIFF_ID` | `/opt/laundrytwin/.env` | rich menu and alert links build `https://liff.line.me/<id>/…` from it | deploy step |
| `LINE_LOGIN_CHANNEL_IDS` (or `LINE_LOGIN_CHANNEL_ID`) | `/opt/laundrytwin/.env` | **the ID-token `client_id`** the server verifies against. It is *not* derived from `LIFF_ID` (`apps/api/src/index.ts` passes it straight to the verifier). Miss this and `liff.init` succeeds, the redirect succeeds, and `/api/auth/liff/exchange` then rejects every token with `INVALID_LIFF_TOKEN` | deploy step |
| `VITE_LIFF_ID` | GitHub Actions **secret** | baked into the SPA at image build time; without it every LIFF branch is compiled out and the release workflow refuses to publish | you (a secret) |
| rich menu URIs | derived from `LIFF_ID` | an old menu keeps the old id until re-synced | admin → "Sync rich menus" |

`LINE_LOGIN_CHANNEL_IDS` accepts a comma-separated list, so the old channel id can stay
while the new one is added — which is what makes the switch reversible without a second
deploy.

Sequence:

```text
1. you: set the VITE_LIFF_ID secret to the new LIFF id
2. you: push any commit (or re-run the Release workflow) -> image with the id baked in
3. deploy: /opt/laundrytwin/.env gets LIFF_ID=<new liff id> and
           LINE_LOGIN_CHANNEL_IDS=<new channel id>[,<old ids>]     (mode 600)
4. deploy the image, then re-sync the rich menu
5. verify: open https://liff.line.me/<new id>/dashboard on a phone that is NOT a
   channel admin, and confirm /api/auth/liff/exchange answers 200. The second half is
   what proves step 3's channel id, not just the publishing.
```

### Rollback

Keep the old ids in `LINE_LOGIN_CHANNEL_IDS` and keep the old `VITE_LIFF_ID` image tag
(rollback refs live in `docs/02_architecture/deploy-runbook.md`). A rollback that only
restores the image leaves `LIFF_ID` pointing at the new channel, so the menüs and the
verifier disagree — restore both together.

## What to verify after the switch

- `https://liff.line.me/<id>/dashboard` opens **inside LINE** for a normal user and
  lands on the sign-in or dashboard screen, not LINE's 400 page.
- The sign-in completes: `/api/auth/liff/exchange` answers 200 and `/api/me` answers
  200 with a grant.
- The rich menu's buttons open the new LIFF URLs (an old menu keeps the old id until it
  is re-synced).
- `GET /api/me` with no session still answers 401 (the auth boundary did not move).

## Not established here

- Which channel type `2011592166` is. The console shows it; the error text is the same
  for both.
- Whether the provider has a verified business. LINE Login with `openid` does not need
  one; an `email` scope may.
