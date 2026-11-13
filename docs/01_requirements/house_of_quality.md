# 🏠 House of Quality + Quantifiable Requirements (LaundryTwin)

**Document Purpose:** Connect the CE Project student handbook methodology
(CR → TC → QR → F → C → T) to the operational requirements already in
`system_requirement.md`. This document adds the *customer-facing layer*
(CR/TC/QR) that the handbook's traceability chain requires; it does **not**
replace R01–R12 or the function list. Each row here links back to its
operational source so the two vocabularies stay aligned.

**Word-of-caution (per handbook final chapter):** LaundryTwin has **no real
Voice of Customer interviews**. All CRs below are **assumed requirements**
backed by evidence from the real deployed system (production warehouse,
384 tests, IRIS integration), advisor/spec framing, and competing-market
products. Every CR is explicitly labelled `[assumed]` — none is dressed up
as a user survey. The CE orientation states VoC is worth *extra* credit this
year, not mandatory.

---

## Step A — Customer Requirements (CR), weighted

Stakeholder groups actually served by this system: **Owner / Branch Manager /
Technician / Customer (public)**. CRs are needs, not solutions (per handbook
ch.3: a CR must survive a technology swap).

| ID | Requirement | Source / evidence | Weight (1–5) |
|---|---|---|---|
| **CR-01** | `[assumed]` Owner/Manager sees up-to-date machine status (state, remaining time, temp) per branch, fast enough to act on it | R02, US-02, F-01; real warehouse data + p95 contract | **5** |
| **CR-02** | `[assumed]` Owner sees gross revenue, cycle counts, and utilization per branch and time window | R03, US-04, F-08; integer-satang revenue + canonical cycle definition | **5** |
| **CR-03** | `[assumed]` Manager/Technician is warned early when gas is low, a machine faults, or a coin box fills | R05, R06, R07, US-01/03/08, F-02/F-10; alert-engine tests + production gas pipeline | **4** |
| **CR-04** | `[assumed]` Owner gets a scoped AI executive summary that only uses their own branches' data | R08, US-05, F-11; allow-listed MCP (6 tools), RBAC scope | **4** |
| **CR-05** | `[assumed]` Multi-branch data is isolated by role; revenue is hidden from technicians; customers only see public availability | R04, R11, US-09/11, F-06/F-07/F-13; cross-branch denial tests | **5** |

The three Phase-2 requirements attach to the nearest CR rather than to a new
one: **R10** (predictive maintenance) → CR-03, **R09** (off-peak recommendation)
and **R12** (weather correlation) → CR-02 as demand intelligence. The bridge
sentence in `system_requirement.md` was corrected to match on 2026-11-13.

*Weighting method:* direct 1–5 scoring (handbook ch.3 simple path), informed by
which requirements the real implementation treats as load-bearing (RBAC
isolation and core BI rank highest). Source of weight is stated, not invented.

---

## Step B — Technical Characteristics (TC), measurable

Each TC is a measurable variable the engineers control, mapped to the ISO/IEC
25010 quality category (handbook ch.4). None is a floating adjective.

| ID | Technical Characteristic | Measure | ISO 25010 category |
|---|---|---|---|
| **TC-01** | Dashboard / digital-twin latency | p95 latency of `/api/report/dashboard` from branch-filtered request to rendered data | Performance efficiency |
| **TC-02** | Cycle-count correctness | `cycleCount` = row count where `status IN ('paid','finished')` (canonical definition, RTM_matrix.md) | Functional correctness |
| **TC-03** | Cross-branch access denial | Unauthorized cross-branch API request returns `403 BRANCH_FORBIDDEN` before the source is queried | Security |
| **TC-04** | Alert deduplication & cooldown | Maximum one alert per `branch:rule:severity` per cooldown window | Reliability |
| **TC-05** | Revenue redaction | Technician revenue field is `null`/redacted; never exposed | Security |
| **TC-06** | Low-gas trend estimate | Early warning emitted from `gas_pressure` + `temperature` + dryer `state` trend | Reliability |
| **TC-07** | AI scope boundary | MCP assistant can only call allow-listed tools with server-derived branch scope; no arbitrary SQL path | Security |
| **TC-08** | Public availability API | Rate-limited read-only endpoint exposing only free/busy/remaining time | Usability / Security |

---

## Step C — House of Quality (CR ↔ TC relationship)

Scale: **9** = strong, **3** = moderate, **1** = weak, — = no significant
relation (evaluated, not forgotten). Target row = the measurable target the
team commits to.

| CR (weight) | TC-01 | TC-02 | TC-03 | TC-04 | TC-05 | TC-06 | TC-07 | TC-08 |
|---|---|---|---|---|---|---|---|---|
| CR-01 (5) | 9 | 3 | — | — | — | — | — | 3 |
| CR-02 (5) | 3 | 9 | — | — | — | — | — | — |
| CR-03 (4) | — | — | — | 9 | — | 9 | — | — |
| CR-04 (4) | — | 1 | 3 | — | 3 | — | 9 | — |
| CR-05 (5) | — | — | 9 | — | 9 | — | 3 | 3 |
| **Target** | p95 ≤ 2 s | = row count `paid`+`finished` | 403 on cross-branch | 1 alert/cooldown | revenue `null` for tech | alert on low-gas trend | allow-list only | rate-limited public DTO |

**Roof (TC ↔ TC conflicts / synergies):**
- TC-01 ↔ TC-03: `+` — a denial that short-circuits before querying also keeps
  latency low (both are cheap fast-paths).
- TC-02 ↔ TC-04: `+` — a correct cycle definition is what lets the alert
  engine count usage without double-counting.
- TC-03 ↔ TC-05: `+` — denial and redaction enforce the same security boundary.
- TC-04 ↔ TC-03: `+` — deduplication/cooldown only *raises* an alert to the
  right recipient; scope is still enforced.
- TC-06 ↔ TC-04: `+` — gas-trend verdict feeds the alert engine.

No strong negative trade-off blocks this design: unlike the AI-latency-accuracy
conflict in the handbook's sleep example, here the characteristics mostly
reinforce rather than fight. The one genuine tension is **TC-08 (public API)
vs TC-05/TC-03 (hide revenue & branch internals)** — the public surface must
mount strict rate limits and shape the response to never leak internal DTOs.

---

## Step D — Quantifiable Requirements (QR), full 5-element spec

Each QR is written with all five elements (metric / operator / threshold /
dataset / condition), per handbook ch.4, so it is provable in the verification
phase. Source chain shown: CR → TC → QR.

**QR-01** *(CR-01 → TC-01 → QR-01)* — "When an authorized branch-manager
request hits `/api/report/dashboard` with a valid branch and date range
(condition), the p95 latency (metric) must be ≤ (operator) 2 seconds
(threshold), measured on the real production warehouse dataset over a 50-request
run."

**QR-02** *(CR-02 → TC-02 → QR-02)* — "The dashboard `cycleCount` KPI (metric)
must equal (operator) the count of warehouse rows whose `status` is `paid` or
`finished` (threshold), over the production `fact_machine_usage` dataset, such
that `sum(trend.cycles) == totals.cycles` (condition)."

**QR-03** *(CR-05 → TC-03, TC-05 → QR-03)* — "An API request for a branch the
principal is not granted (condition) must return HTTP 403 or a null/redacted
revenue field (metric/threshold), verified by the automated cross-branch and
technician-revenue tests in the repository."

**QR-04** *(CR-03 → TC-04, TC-06 → QR-04)* — "When the alert sweep finds an
eligible recipient for the same `branch:rule:severity` within one cooldown
window (condition), the engine delivers at most (operator) one notification
(metric/threshold), measured by `apps/api/src/alert-engine.test.ts`."

**QR-05** *(CR-04 → TC-07 → QR-05)* — "When the AI assistant is asked for a
summary (condition), it may call only (operator) the allow-listed set of six
MCP analytics tools (metric/threshold) with a server-derived branch scope,
measured by the `analytics/mcp.test.ts` allow-list and scope tests."

---

## Full traceability skeleton (one walkable chain)

```
[assumed] CR-05 (multi-branch isolation)
   └─ TC-03 (cross-branch denial) ──┐
       └─ TC-05 (revenue redaction) ─┴→ QR-03 (403 / redacted)
                                              └─ F-06 (RBAC), F-07 (Auth/Audit), F-13 (public API)
                                                      └─ C: Hono API + analytics scope gate
                                                              └─ T: access-policy.test.ts, scope.test.ts
```

This is the missing customer-facing head of the chain that `RTM_matrix.md` was
cutting off at F. The C/T legs are mapped in the updated RTM.
