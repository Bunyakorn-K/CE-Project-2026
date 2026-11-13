# LIFF moved to a published LINE Login channel

**Date:** 2026-11-13
**Commit:** `4aab158` · image `laundrytwin:deploy-4aab158-20261113`
**Digest:** `sha256:06cfa874a80c5b900428f74956913ff8143b1f81bad430bf498b902d875e724e`

## Why

Every ordinary user hit LINE's own page before the app loaded:

> 400 Bad Request — This channel is now developing status. User need to have developer role.

The channel that owned the previous LIFF app (`2011592166-uToRdTwS`) was unpublished, so
only channel admins could sign in. A LIFF app inside an unpublished channel behaves the
same way, so this was never fixed by choosing a different SDK.

## What changed

| value | before | after |
|---|---|---|
| `LIFF_ID` | `2011592166-uToRdTwS` | `2011807354-DuoPfzrR` |
| `LINE_LOGIN_CHANNEL_IDS` | `2011592166,2011592167,2011592168` | `2011807354,2011592166,2011592167,2011592168` |
| `VITE_LIFF_ID` (CI secret) | `2011592166-uToRdTwS` | `2011807354-DuoPfzrR` |

The old channel id is **kept** in `LINE_LOGIN_CHANNEL_IDS` — the verifier accepts a
list, so a rollback does not need a second redeploy to re-open the old tokens.

`LINE_LOGIN_CHANNEL_IDS` is the part that would have been missed: it is the `client_id`
the server sends to `oauth2/v2.1/verify` (`apps/api/src/index.ts` → `verifyLiffIdToken`),
and nothing derives it from `LIFF_ID`. Updating only the LIFF id and the image would
publish, redirect, and then reject every token with `LIFF_VERIFICATION_FAILED` — a
sign-in failure that looks like a broken deployment.

## Evidence

Measured, in order:

```text
build before the secret was updated
  digest sha256:99e5e6fb…          ← identical to the deployed image
  bundle "2011592166-uToRdTwS" ×3  ← the build arg had not changed, so the cache
                                     returned the old layers: the secret was still old

build after the secret was updated
  digest sha256:06cfa874…          ← different
  bundle "2011807354-DuoPfzrR" ×3  ← new id baked in, old id absent

deployed image  laundrytwin:deploy-4aab158-20261113
  LIFF_ID=2011807354-DuoPfzrR
  LINE_LOGIN_CHANNEL_IDS=2011807354,2011592166,2011592167,2011592168
  health 200

public bundle (https://laundrytwin.duckdns.org)
  assets/index-D6pnF4YT.js → "2011807354-DuoPfzrR"

auth boundary unchanged
  GET  /api/me                     401
  POST /api/auth/liff/exchange     401 LIFF_VERIFICATION_FAILED  (bogus token)
  GET  /dashboard                  200 (SPA)
```

The identical digest before the secret changed is the useful half of this record: a
rebuild that "succeeds" is not evidence the build inputs changed, and grepping the
produced bundle for the expected id is what distinguishes the two.

## Still outstanding

1. **Rich menu re-sync.** LINE still holds four menus whose buttons point at
   `https://liff.line.me/2011592166-uToRdTwS/…`:

   ```text
   laundrytwin:manager:v3      → /2011592166-uToRdTwS/dashboard
   laundrytwin:owner:v3        → /2011592166-uToRdTwS/dashboard
   laundrytwin:technician:v3   → /2011592166-uToRdTwS/dashboard
   laundrytwin:default:v3      → (message actions only)
   ```

   LINE cannot edit a menu, so a sync creates new menus and relinks users. It is
   owner-only (`POST /api/admin/rich-menus/sync`, button at `/admin/line`), and a
   deploy token is not an owner session — so this step is the owner's click, not a
   deploy step.

2. **A real sign-in on the new channel.** `/api/auth/liff/exchange` is proven wired and
   is now verifying against the new client id, but no live token has been traded since
   the switch. The check that closes it: open
   `https://liff.line.me/2011807354-DuoPfzrR/dashboard` on a phone that is **not** an
   admin of the channel, sign in, and confirm `/api/auth/liff/exchange` answers 200.
   Until that is done, "the channel is published" is the owner's statement, not a
   measurement from here.
