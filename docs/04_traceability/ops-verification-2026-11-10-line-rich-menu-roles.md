# A rich menu per role

**Date:** 2026-11-10
**Commit:** `daa390f` · image `sha256:677edd57…` · deployed as
`laundrytwin:deploy-daa390f-20261110`
**Status:** four menus live on the OA, the one known user is linked, and the
images are byte-identical to the committed PNGs.

## Why per role

The panel above the keyboard was whatever the OA shipped with. LINE lets a bot own
many rich menus and link one to each user, so the panel can match what that person
may actually open: an owner has a backoffice, a technician does not, and a button
that answers 403 is worse than a smaller panel.

| menu | areas | who |
|---|---|---|
| `laundrytwin:owner:v1` | ภาพรวม · วิเคราะห์ · เครื่องซักผ้า · ผู้ดูแล | `owner` |
| `laundrytwin:manager:v1` | ภาพรวม · วิเคราะห์ · เครื่องซักผ้า | `manager` |
| `laundrytwin:technician:v1` | ภาพรวม · เครื่องซักผ้า · **แจ้งซ่อม** (message) | `technician` |
| `laundrytwin:default:v1` | ขอสิทธิ์ใช้งาน (message) | no grant yet |

The strongest grant wins, so a panel never hides a page the user may open. The
technician's third area is a message action rather than a page because what a
technician reaches for when a machine misbehaves is a person, and a message the
user sends is answered with a free reply.

## The two facts that shaped the code

**Rich menus are free.** They are not messages, so linking does not touch the
300-a-month push allowance the alerts are budgeted against. That is why the link
happens on **every LIFF login** (one call, free) instead of a scheduled bulk sync —
a role change reaches the user the next time they open the app. A failure there is
swallowed on purpose: the panel is cosmetic, the session is not.

**LINE cannot edit a menu.** Only create and delete. So the sync creates the four
new menus, uploads their images, sets the default and links every known user, and
only then deletes the menus it owned before — a failure halfway leaves the old
panel working rather than nobody's. The ids LINE assigns change on every sync, so
they live in a `rich_menu` table; the login path reads that row rather than calling
LINE, because a login must not fail when a menu lookup is slow.

## The image

`deploy/line/render-rich-menus.py` draws the PNGs from the same definitions the
sync uploads, and they are committed and baked into the image at `/app/rich-menus`.

Two attempts were needed:

1. **Pillow cannot shape Thai.** The wheel has no Raqm, so every vowel and tone
   mark came out as the dotted-circle placeholder — `วิเคราะห์` rendered as
   `ว◌ิเคราะห์`. The renderer now writes HTML and screenshots it with headless
   Chrome, which shapes Thai correctly. That makes rendering a local, one-off step;
   nothing in CI or the container needs a browser.
2. **Per-column font sizes looked broken.** Sizing each label to fill its own
   column made `ภาพรวม` twice the height of `เครื่องซักผ้า`. One size for the whole
   panel — the largest that fits the longest label — reads as a panel.

Pillow is still used, to *measure* labels so a size can be chosen before Chrome
draws; Thai marks count as full advances there, so the measurement is corrected by
a constant (0.82) rather than trusted.

## Evidence

Sync over HTTPS with an owner session (throwaway account, deleted afterwards):

```text
POST /api/admin/rich-menus/sync   200
  created 4 · deleted 0 · linked 1 · failed 0
  owner      richmenu-295a4f2365b4537b91290a1dae37830c
  manager    richmenu-417fd55a6acfa85d40269173e9c4469f
  technician richmenu-a62b7a912fc6e4ac17c5e1eabd7d0e3c
  default    richmenu-3d4ef3af142037171807049e9776d354   (set as default)
```

Read back from LINE:

```text
GET /v2/bot/richmenu/list          4 menus, 2500x843, 4/3/3/1 areas, names as above
GET /v2/bot/user/{realUser}/richmenu   richmenu-295a4f23…  (= owner menu)
GET /v2/bot/user/all/richmenu          richmenu-3d4ef3af…  (= default menu)
GET (api-data) .../content           owner 41607 · manager 43635 ·
                                     technician 45525 · default 34555 bytes
                                     — identical to the committed PNGs
```

Cleanup verified, not assumed: `sessions 1, account 1, grant 1, user 1` deleted →
`0/0/0/0`, tables back to `5 users / 4 grants`, and `rich_menu` holds the four keys.

## The mistake worth recording

The first read-back used `https://api.line.me/v2/bot/richmenu/{id}/content` and
returned **404 for all four menus** — which looks exactly like "the upload never
happened". The uploads were fine: image operations live on `api-data.line.me`, and
`api.line.me` serves the menu object, not its picture. A 404 there is a wrong host,
not a missing image; probing with `POST` gave `400 "An image has already been
uploaded to the richmenu"`, which is what settled it.

## Not verified

- **How it looks in the LINE app.** The images are confirmed present and correct
  byte-for-byte, but a rendered panel on a phone — spacing, whether the labels read
  comfortably at that size — has not been seen. That needs a screenshot from the
  owner.
- **A real technician or manager.** There is one LINE identity linked in
  production and it is an owner, so the technician and manager menus are created and
  defaulted but have never been linked to a person.
- **The `default` menu for an unlinked account.** It is the OA-wide fallback; an
  account with no grant that opens chat should see ขอสิทธิ์ใช้งาน, unobserved so far.

## Update: tiles with icons, and a conversation starter (v2)

The v1 panels were text on a dark bar. The owner sent a reference image of LINE's
own tiled style and asked for that, plus a button that starts a conversation.

- **Icons and colours per tile.** Each area carries an icon name and a hex colour;
  the renderer draws the glyph as inline SVG. The icons are the ones the web app
  uses in its own navigation (grid, chart, washer, shield), so the panel and the app
  read as one product — with the washer redrawn as a drum in a cabinet, because the
  app's line-panel icon does not say "washing machine" at 280px.
- **Every menu can open a conversation.** The `แชทกับ AI` tile is a `message`
  action that sends `สวัสดี` as the user. That is the difference between "the panel
  links to the web app" and "the panel can start a chat with the assistant", and
  because it is a message the user sends, the answer is a free reply — it costs
  nothing against the 300-a-month allowance. The technician's `แจ้งซ่อม` uses the
  same mechanism with a different opener.
- Owner now has five tiles (the backoffice earns its own), manager and technician
  four, the fallback two.
- Names moved to `:v2`. LINE cannot edit a menu, so the old four were created as new
  objects and the v1 ones deleted in the same sync.

Verified after the sync (`ef85be1`, image `sha256:58143383…`):

```text
POST /api/admin/rich-menus/sync   200 · created 4 · deleted 4 · linked 1 · failed 0
GET  /v2/bot/richmenu/list        4 menus, v2 only:
     owner       5 areas  [uri, uri, uri, uri, message]
     manager     4 areas  [uri, uri, uri, message]
     technician  4 areas  [uri, uri, message, message]
     default     2 areas  [message, message]
GET  /v2/bot/richmenu/{owner}     last action: message -> "สวัสดี"
GET  /v2/bot/user/{user}/richmenu richmenu-8de855f7…  (owner v2)
GET  /v2/bot/user/all/richmenu    richmenu-62103122…  (default v2)
GET  (api-data) .../content       owner 83741 · manager 82499 ·
                                  technician 83771 · default 55317 bytes
                                  — identical to the committed PNGs
```

Still not seen: the panel rendered on a phone. The pixels are confirmed present and
correct; how the labels read at LINE's display size is the owner's call.

## Update: the owner panel gets a hero tile (v3)

Five tiles in one row squeezed every label into a 400px column. The owner asked for
one tile across the top instead — which is not a bounds tweak but a different panel
shape:

- **2500x1686, top 40% is one full-width tile**, the remaining four split the row
  beneath (625x1012 each). The other three menus keep 2500x843 and one row.
- Definitions now carry their own `size` and a `layout` (`row` | `hero`), and
  `buildRichMenuObject` sends the definition's size rather than a global constant —
  LINE rejects an image whose dimensions disagree with the object.
- Bounds are tested to tile the image **exactly** for 2..6 areas: an uncovered strip
  shows the canvas colour through the panel, a seam down the middle of the chat. The
  last tile in the row takes the remainder pixels for the same reason.
- The renderer places tiles from the bounds rather than assuming a grid, and flips a
  tile much wider than it is tall to icon-beside-label: stacked, a 2472px tile is a
  small icon floating in an empty band. The hero also gets a larger label cap
  (168px), so it reads as the primary button instead of a sixth equal one.

Verified after the sync (`bf83630`, image `sha256:1a45127c…`):

```text
POST /api/admin/rich-menus/sync   200 · created 4 · deleted 4 · linked 1 · failed 0
GET  /v2/bot/richmenu/list        4 menus, v3 only
  laundrytwin:owner:v3       2500 x 1686 · 5 areas
      (0, 0, 2500, 674)                       <- hero, full width
      (0, 674, 625, 1012) (625, 674, …) (1250, 674, …) (1875, 674, …)
  laundrytwin:manager:v3     2500 x 843 · 4 areas  625 wide each
  laundrytwin:technician:v3  2500 x 843 · 4 areas  625 wide each
  laundrytwin:default:v3     2500 x 843 · 2 areas 1250 wide each
GET  /v2/bot/user/{user}/richmenu  richmenu-4df1a5d5… (owner v3)
GET  /v2/bot/user/all/richmenu     richmenu-2b528a88… (default v3)
GET  (api-data) .../content        owner 115252 · manager 82499 ·
                                   technician 83771 · default 55317 bytes
                                   — identical to the committed PNGs
```

Still not seen: the panel on a phone, and the tall shape in particular — it covers
more of the chat than the wide one, which is the trade the hero tile buys.
