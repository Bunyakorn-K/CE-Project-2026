# The bot asks which branch, and says money in baht

**Date:** 2026-11-12
**Commit:** `baf61f8` (on top of `2b6e429` and `5995083`) · image
`sha256:e7009597…` · deployed as `laundrytwin:deploy-baf61f8-20261112`
**Status:** live and verified with real LINE webhooks against production.

## The two symptoms, from one screenshot

A shop owner asked "ภาพรวมวันนี้เป็นยังไง" and got a card headed with one branch, two
branches' numbers inside it, a total underneath, and every amount written twice:
`96,000 สตางค์ = 960 บาท`.

## Money: the conversion was never a feature

The prompt asked for baht and the model complied, then printed the arithmetic it had
done. `bahtOnly()` makes the output certain whatever the model writes: the
`X สตางค์ = Y บาท` pair collapses to the baht it already computed, a lone satang figure
is divided by 100, and the pair rule runs first so the baht half is never converted
twice. The prompt now also forbids the unit outright.

Verified: `รายได้: 4,230 บาท`, `รายได้: 7,340 บาท` — no `สตางค์` in either production
answer.

## Branch: it was answered, not chosen

Three things were wrong, and each needed its own fix.

1. **Nothing asked.** `shouldAskWhichBranch` fires only for a scope-less overview
   (ภาพรวม / สรุป / รายได้ / วันนี้ …), only when the person can see more than one
   branch, only when nothing is remembered, and only when the question names no branch.
   A question about a machine, an alert or a temperature is answerable without a
   scope, and asking on every message would be worse than the problem.
2. **The tap had nowhere to answer.** The question is held in `chat_pending` (one row
   per person, ten minutes, replaced by a newer question) because the tap is a separate
   webhook request. The tap sets the preference and answers the held question in the
   same free reply — the card's header names the branch, which is what "จำไว้แล้ว"
   would have said.
3. **The preference changed the prompt, not the data.** The tools ran on the person's
   full scope, so the model queried every branch and headed the card "ทุกสาขา".
   `narrowScopeToBranch` returns the scope the MCP calls run with: the remembered
   branch alone, unless that branch has left their grants or the question names a
   different one.

## One more leak, found while verifying

With the scope narrowed, the tap's answer still came back "ทุกสาขา" — the model had
last turn's wider card in its prompt, read it as already answered, and made **no tool
call at all** (steps 1, tool calls 0). `chat_turn` now records the scope an answer was
computed for and `recentTurns` only feeds back turns from the same scope. The row stays
as the record; the prompt does not cite it. Same shape as the tool-error fix.

## Evidence (production, signed webhooks)

```text
1) "ภาพรวมวันนี้เป็นยังไง" with two branches and no preference
   -> chat_pending holds the question, chat_turn count unchanged (no model call)

2) tap "หลิ่งมื่น"
   scope_key 5e9611c1… (one branch) · steps 2 · tool calls 2
   "ภาพรวมวันนี้ (2026-11-12) สาขา about you.wash & dry แม่โจ้ - หลิ่งมื่น
    - รายได้: 4,230 บาท · รอบซัก: 71 · 32.8 นาที/รอบ"
   no สตางค์ · no other branch's numbers

3) "แล้วเมื่อวานล่ะ"
   answered without asking again · 7,340 บาท · 116 รอบ · same scope_key
```

```text
image     laundrytwin:deploy-baf61f8-20261112   (docker inspect)
APP_IMAGE laundrytwin:deploy-baf61f8-20261112
health    200
tables    chat_pending present · chat_turn.scope_key present
tests     793 API / 330 web / 117 ETL · build 0 · check 0
```

## Known behaviour, not fixed here

- A provider-side flake appeared twice during verification:
  `AI_NoOutputGeneratedError` from the gateway, which reaches the person as the
  standard failure message and stores no turn. No retry is implemented.
- The picker offers at most twelve branches plus "ทุกสาขา"; a person with more gets the
  first twelve and has to name the rest in words.
- Chooses one branch at a time. "ขอทั้งสองสาขา" still works by not choosing — the model
  answers across the visible scope when the question names both.

---

# A swipeable card per branch

**Commit:** `362c4c7` · image `laundrytwin:deploy-362c4c7-20261112`

An answer that covers several branches used to arrive as one tall bubble with every
branch's numbers stacked in it; the reader had to find where their branch ended. LINE's
carousel is the right container: one bubble per branch, swiped sideways.

## Reading the shape the answer already has

The prompt asks for one block per branch, so `parseSections` reads that back rather
than inventing a second format: a heading that names a branch (`สาขา: …`,
`### สาขา: …`, `Branch: …`) starts a section, and `ชื่อ: ค่า` lines belong to it. Prose
without such a heading does not become a branch.

`buildBranchCarousel` returns `null` for a single branch — that is a card, not a
carousel — and caps at LINE's twelve bubbles.

## Two defects found while building it

1. **The model asked a question the code had already settled.** A prompt rule told it
   to ask "which branch?" on an unscoped overview, duplicating the picker and firing
   even when the person had written "ทุกสาขา" — the reply was one sentence, no tools,
   no card. Removed; the code decides the scope, the prompt only shapes the answer.
2. **The first branch was written without `###`.** The model opens with `สาขา: …` and
   continues with `### สาขา: …`. Reading only the heading form turned the first branch
   into rows under an untitled section, which a carousel cannot show — the branch was
   silently dropped. A bare `สาขา:` line now starts a section too.

## Evidence

```text
LINE POST /v2/bot/message/validate/push   -> 200 {}   (the exact carousel)
production turn                          card_kind=carousel
answer parsed with the shipped code      sections=3  branchSections=3  bubbles=3
bubble headers                           ตลาดโซนเหลือง | หลิ่งมื่น | สรุปรวม
```

`chat_turn.card_kind` records what the person actually received — `carousel`, `card` or
`text` — because `deliver` now reports it rather than returning a bare delivery status.
That is what made this verifiable from the database instead of from a screenshot.

```text
803 API / 330 web / 117 ETL · build 0 · check 0
image laundrytwin:deploy-362c4c7-20261112 · health 200
```

## Known behaviour

- A repeated question inside the same scope can be answered from the transcript without
  a tool call (`steps 1, tool calls 0`) — the model echoes its previous card. The
  numbers are then as old as that turn.
- The carousel shows at most twelve branches; the rest are dropped, not paged.
