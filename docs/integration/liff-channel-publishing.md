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

No code. Three values, in two places:

| value | where | who |
|---|---|---|
| `VITE_LIFF_ID` | GitHub Actions **secret** — baked into the SPA at image build time | you (a secret) |
| `LIFF_ID` | `/opt/laundrytwin/.env` — the bot's rich menus and alert links | deploy step |
| rich menu URIs | derived from `LIFF_ID`, so they must be re-synced | admin → "Sync rich menus", or `POST /api/admin/rich-menus/sync` |

`liffUri()` builds `https://liff.line.me/<id>/<path>`, so the rich menu and every alert
link follow the new id automatically once it is re-synced.

Sequence:

```text
1. set the VITE_LIFF_ID secret to the new id
2. push any commit (or re-run the Release workflow) -> new image with the id baked in
3. /opt/laundrytwin/.env: LIFF_ID=<new id>   (mode 600)
4. deploy the image, then re-sync the rich menu
5. verify: open https://liff.line.me/<new id>/dashboard on a phone that is NOT a
   channel admin. That is the only check that proves the channel is published.
```

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
