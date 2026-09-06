# LaundroTwin MVP — Use Case and Sequence Diagrams

Scope: the **current implementation** (read-only LINE LIFF reporting surface,
RBAC, ClickHouse analytics, MCP assistant, LINE bot, alert engine). The target
design's activity flows live in `data-and-activity-diagrams.md`; where this
document and that one differ, this document describes what the code actually
does today.

## Actors

| Actor | Description | Related roles |
| :---- | :---------- | :------------- |
| **Owner** | Franchise owner. Tenant-wide access, manages access grants, receives all severities. | `owner` |
| **Branch Manager** | Operates one assigned branch; sees branch KPIs and alerts. | `manager` |
| **Technician** | Diagnoses machines; receives machine-related alerts. | `technician` |
| **LINE User (LIFF)** | Approached via LINE LIFF; must be linked to an approved account to see the dashboard. | `liff_identity` |
| **LINE Platform** | LINE Messaging API / LIFF infrastructure (webhook push, message delivery). | external |
| **IRIS Read API** | Upstream read-only source of branches, machines, cycles, alerts, events. | external |
| **ClickHouse** | LaundryTwin analytics warehouse (dim + fact tables). | external |

## Use Case Diagram

```mermaid
flowchart LR
    subgraph OWNER_UC["Owner"]
        A1["View tenant dashboard & KPIs (F-08, US-04)"]
        A2["View live machine status (F-01, US-02)"]
        A3["Chat with Executive Assistant (F-11, US-05)"]
        A4["Approve / revoke access grants (F-06, US-11)"]
        A5["Trigger alert sweep (F-10)"]
        A6["View & acknowledge alerts (F-10)"]
    end

    subgraph MGR_UC["Branch Manager"]
        M1["View own-branch KPIs (F-08, US-04)"]
        M2["View own-branch live status (F-01, US-02)"]
        M3["Receive & acknowledge alerts (F-10, US-01/US-03)"]
    end

    subgraph TECH_UC["Technician"]
        T1["View machine details (F-01, US-02)"]
        T2["Receive machine anomaly alerts (F-10, US-08)"]
    end

    subgraph LIFF_UC["LINE User (LIFF)"]
        L1["Sign in via LIFF (F-07)"]
        L2["Request access (F-06, US-11)"]
    end

    subgraph SYS_UC["System"]
        S1["ETL: IRIS → ClickHouse (F-05)"]
        S2["Alert engine sweep → LINE push (F-10)"]
        S3["Webhook: LINE bot conversation (F-11)"]
    end

    A1 --- A2
    A3 --> S3
    A5 --> S2
    A6 --> S2
    M1 --- M2
    M3 --> S2
    T2 --> S2
    L1 --> L2
    S1 --> S2
    S2 --> M3
    S2 --> T2
    S3 --> A3
```

## Use Case Descriptions

### UC-01: View branch dashboard and KPIs (F-08, US-04)
- **Primary actor:** Owner, Branch Manager
- **Preconditions:** Authenticated session; principal resolved; grant covers the branch.
- **Flow:** Actor selects branch/time range → API authorizes via `canAccessBranch` → aggregates queried from ClickHouse → response envelopes data source + freshness (`analyticsEnvelope`).
- **Postconditions:** Owner sees tenant totals; manager sees only assigned branch; revenue hidden for non-owner/manager roles (`redactDashboardRevenue`).
- **Failure:** 401 no session; 403 branch forbidden; 503 analytics source unavailable.

### UC-02: View live machine status (F-01, US-02)
- **Primary actor:** Owner, Branch Manager, Technician
- **Flow:** Actor requests `/api/report/live` for a single branch → `iris.getLiveSnapshot` → machines with state, remainingSeconds, temperatureC, freshness (`fresh`/`stale`/`unavailable`).
- **Postconditions:** Missing/stale values preserved as null or flagged — never fabricated.
- **Failure:** 400 when no branch selected for non-owner; 403 for unauthorized branch.

### UC-03: Chat with the Executive Assistant (F-11, US-05)
- **Primary actor:** Owner (LINE bot)
- **Flow:** LINE text message → webhook signature verified → identity resolved → prompt + branch context sent to assistant → assistant calls allow-listed MCP analytics tools → answer pushed back.
- **Postconditions:** Only allow-listed tools executed; branch scope enforced; busy-set drops overlapping requests.
- **Failure:** unknown LINE user → access-request recorded + guidance message; LLM error → apologetic fallback message.

### UC-04: Approve / revoke access grants (F-06, US-11)
- **Primary actor:** Owner
- **Flow:** Owner lists pending LIFF requests → approves with role + branch (or revokes a grant) → `access_grant` row written; audit log entry appended.
- **Constraints:** owner is tenant-wide (branchId null); manager/technician require exactly one branch; last-owner grant cannot be revoked.

### UC-05: Receive and acknowledge alerts (F-10, US-01/US-03/US-08)
- **Primary actor:** Owner, Branch Manager, Technician
- **Flow:** Alert sweep fetches IRIS alerts → engine selects recipients by severity role + branch → LINE push (idempotent per alert+recipient, cooldown per class) → dashboard shows alerts with acknowledged state; actor acknowledges → `alert_acknowledgement` row + audit.
- **Postconditions:** At most one push per (alert, recipient); repeat occurrences suppressed by cooldown key `branch:rule:severity`; every attempt audited in `alert_notification`.

### UC-06: Request access from LIFF (F-06, US-11)
- **Primary actor:** LINE User (LIFF)
- **Flow:** Unknown user exchanges LINE ID token → `liff_access_request` pending row created → owner approves (UC-04) → `liff_identity` + grant created; subsequent sign-in resolves a real principal.

## Sequence Diagrams

### SD-1: Dashboard report fetch (RBAC-scoped)

```mermaid
sequenceDiagram
    actor U as Owner / Manager
    participant W as React Web (LIFF)
    participant A as Hono API
    participant I as IRIS Read API
    participant C as ClickHouse

    U->>W: Open dashboard / select branch & range
    W->>A: GET /api/report/dashboard?branchId=&from=&to=
    A->>A: Resolve principal (Better Auth / LIFF / demo)
    alt no session
        A-->>W: 401 AUTHENTICATION_REQUIRED
    else unauthorized branch
        A-->>W: 403 BRANCH_FORBIDDEN
    else ok
        A->>I: getDashboard(range, branchId)
        I-->>A: dashboard envelope (source, fetchedAt, branches, kpis)
        A->>A: redactDashboardRevenue (role policy)
        A-->>W: 200 scoped dashboard JSON
        W-->>U: Render KPIs + last-updated timestamp
    end
```

### SD-2: Alert engine sweep → LINE push

```mermaid
sequenceDiagram
    actor T as Timer / Admin (POST /api/admin/alerts/notify)
    participant E as Alert Engine
    participant I as IRIS Read API
    participant D as SQLite (alert_notification)
    participant L as LINE Messaging API
    participant R as Recipient LINE user

    T->>E: runAlertSweep(alerts, deps)
    E->>I: getAlerts(from, to)
    I-->>E: alert list (severity, branchId, ruleId, evidence)
    loop each alert
        E->>E: skip if acknowledged (source or local)
        E->>E: select recipients (severity role ∩ branch grant ∩ LINE-linked)
        alt no recipient
            Note over E: count noRecipients
        else cooldown hit (branch:rule:severity within ALERT_COOLDOWN_MS)
            E->>D: audit_log alert.skipped_cooldown
        else claim slot (UNIQUE alert+recipient)
            alt LINE channel missing
                E->>D: status=failed (not configured)
            else send
                E->>L: pushMessage({to, messages})
                alt accepted
                    L-->>E: ok
                    E->>D: status=sent, deliveredAt
                else rejected
                    L-->>E: error
                    E->>D: status=failed, error
                end
            end
        end
    end
    L-->>R: 🔔 LaundryTwin alert (severity, title, evidence meta)
```

### SD-3: LINE bot conversation (Executive Assistant)

```mermaid
sequenceDiagram
    actor U as Owner (LINE)
    participant LP as LINE Platform
    participant A as Hono API (webhook)
    participant B as Bot handler
    participant M as MCP analytics server
    participant C as ClickHouse

    U->>LP: text question
    LP->>A: POST /webhooks/line (x-line-signature)
    A->>A: verify signature (isValidLineSignature)
    alt invalid signature
        A-->>LP: 401
    else valid
        A-->>LP: 200 ack (async answer)
        B->>B: resolveLineIdentity(userId)
        alt unknown user
            B->>A: recordPendingLiffAccessRequest
            B-->>LP: push "ยังไม่ได้รับสิทธิ์"
        else known
            B->>C: listBranchNames (scope-filtered)
            B->>M: answerForMessage (tools, branch context)
            M->>C: allow-listed analytics query
            C-->>M: aggregates
            M-->>B: answer
            B-->>LP: pushMessage(answer)
            LP-->>U: 📱 answer
        end
    end
```

### SD-4: LIFF access approval

```mermaid
sequenceDiagram
    actor U as LINE user (new)
    actor O as Owner
    participant W as React Web (LIFF)
    participant A as Hono API
    participant D as SQLite

    U->>W: Open LIFF app (LINE ID token)
    W->>A: POST /api/auth/liff/exchange {idToken}
    A->>A: verifyLiffIdToken (channel ID)
    alt unknown user
        A->>D: insert liff_access_request (pending)
        A-->>W: 403 ACCESS_PENDING
    else known + granted
        A->>D: create liff_session
        A-->>W: 200 {user, roles}
    end
    O->>A: GET /api/admin/access-requests (owner)
    A-->>O: pending list
    O->>A: POST /api/admin/access-requests/:id/approve {role, branchId}
    A->>A: validate role/branch rules
    A->>D: create liff_identity + access_grant; audit access_request.approved
    A-->>O: 200 {user}
```

## Maintenance rules

- Update SD-1 when report authorization or the IRIS contract changes.
- Update SD-2 when alert dedup/cooldown semantics change (also see
  `apps/api/src/alert-engine.ts` and its tests).
- Keep actors aligned with `access-policy.ts` roles (`owner`, `manager`, `technician`).
