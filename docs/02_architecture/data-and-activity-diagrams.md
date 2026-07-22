# LaundroTwin MVP Data and Activity Diagrams

This document describes the target LaundroTwin MVP. It is a logical design for
the CE Project report and future implementation; it does not claim that every
entity and workflow is already implemented by the current LaundryGo application.

## Entity Relationship Diagram

The model separates immutable source events, the latest Digital Twin snapshot,
and derived business records. This keeps KPI, alert, and AI results traceable to
versioned source data.

```mermaid
erDiagram
    TENANT ||--o{ BRANCH : owns
    TENANT ||--o{ MEMBERSHIP : grants
    USER ||--o{ MEMBERSHIP : receives
    BRANCH o|--o{ MEMBERSHIP : limits_scope

    BRANCH ||--o{ MACHINE : contains
    REGISTER_MAP ||--o{ REGISTER_DEFINITION : defines
    REGISTER_MAP ||--o{ MACHINE : configures

    TENANT ||--o{ TELEMETRY_EVENT : scopes
    BRANCH ||--o{ TELEMETRY_EVENT : receives
    MACHINE ||--o{ TELEMETRY_EVENT : emits
    REGISTER_MAP ||--o{ TELEMETRY_EVENT : decodes
    TENANT ||--o{ INGESTION_REJECTION : records
    BRANCH o|--o{ INGESTION_REJECTION : may_scope
    MACHINE ||--o| MACHINE_SNAPSHOT : has_latest
    BRANCH ||--o{ MACHINE_SNAPSHOT : scopes

    MACHINE ||--o{ MACHINE_CYCLE : runs
    BRANCH ||--o{ MACHINE_CYCLE : scopes
    MACHINE ||--o{ PAYMENT_EVENT : receives
    BRANCH ||--o{ PAYMENT_EVENT : scopes
    TELEMETRY_EVENT o|--o{ PAYMENT_EVENT : supports
    BRANCH ||--o{ GAS_SENSOR : contains
    GAS_SENSOR ||--o{ GAS_PRESSURE_EVENT : emits
    BRANCH ||--o{ GAS_PRESSURE_EVENT : scopes
    MACHINE ||--o{ COIN_BOX_ESTIMATE : has
    BRANCH ||--o{ COIN_BOX_ESTIMATE : scopes
    MACHINE ||--o{ COIN_BOX_RESET : resets
    BRANCH ||--o{ COIN_BOX_RESET : scopes
    USER o|--o{ COIN_BOX_RESET : performs

    TENANT ||--o{ ALERT_RULE : defines
    BRANCH o|--o{ ALERT_RULE : may_override
    ALERT_RULE ||--o{ ALERT_EVENT : triggers
    BRANCH ||--o{ ALERT_EVENT : scopes
    MACHINE o|--o{ ALERT_EVENT : may_target
    GAS_SENSOR o|--o{ ALERT_EVENT : may_target
    USER o|--o{ ALERT_EVENT : acknowledges
    ALERT_EVENT ||--o{ ALERT_DELIVERY : dispatches

    TENANT ||--o{ AUDIT_LOG : owns
    BRANCH o|--o{ AUDIT_LOG : may_scope
    USER o|--o{ AUDIT_LOG : acts
    TENANT ||--o{ AI_REQUEST : scopes
    USER ||--o{ AI_REQUEST : submits
    AI_REQUEST ||--o{ AI_TOOL_CALL : invokes
    TENANT ||--o{ AI_TOOL_CALL : scopes

    TENANT {
        string tenant_id PK
        string name
        string status
        datetime created_at
    }

    BRANCH {
        string branch_id PK
        string tenant_id FK
        string name
        string timezone
        string status
        datetime created_at
    }

    USER {
        string user_id PK
        string email
        string display_name
        string status
        datetime created_at
    }

    MEMBERSHIP {
        string membership_id PK
        string tenant_id FK
        string branch_id FK
        string user_id FK
        string role
        datetime granted_at
        datetime revoked_at
    }

    REGISTER_MAP {
        string register_map_id PK
        string machine_model
        string version
        string status
        datetime created_at
    }

    REGISTER_DEFINITION {
        string register_definition_id PK
        string register_map_id FK
        int register_address
        string field_name
        string data_type
        string unit
        string decode_rule
    }

    MACHINE {
        string machine_id PK
        string branch_id FK
        string register_map_id FK
        string display_name
        string machine_type
        string status
        datetime installed_at
    }

    TELEMETRY_EVENT {
        string telemetry_event_id PK
        string tenant_id FK
        string branch_id FK
        string machine_id FK
        string register_map_id FK
        datetime event_timestamp
        datetime received_at
        string payload_hash
        string data_quality_status
        string raw_payload_ref
    }

    INGESTION_REJECTION {
        string rejection_id PK
        string tenant_id FK
        string branch_id FK
        datetime received_at
        string payload_hash
        string reason_code
        string raw_payload_ref
    }

    MACHINE_SNAPSHOT {
        string machine_id PK, FK
        string branch_id FK
        string state
        int remaining_seconds
        decimal temperature_c
        string door_status
        datetime updated_at
        datetime stale_after
    }

    MACHINE_CYCLE {
        string cycle_id PK
        string branch_id FK
        string machine_id FK
        datetime started_at
        datetime ended_at
        string program_code
        int paid_satang
        string status
    }

    PAYMENT_EVENT {
        string payment_event_id PK
        string branch_id FK
        string machine_id FK
        string telemetry_event_id FK
        int amount_satang
        string payment_method
        string counter_semantics
        datetime occurred_at
    }

    GAS_SENSOR {
        string gas_sensor_id PK
        string branch_id FK
        string sensor_code
        string pressure_unit
        string status
    }

    GAS_PRESSURE_EVENT {
        string gas_pressure_event_id PK
        string gas_sensor_id FK
        string branch_id FK
        datetime event_timestamp
        decimal pressure_value
        decimal ambient_temperature_c
        string quality_status
    }

    COIN_BOX_ESTIMATE {
        string coin_box_estimate_id PK
        string branch_id FK
        string machine_id FK
        decimal estimated_fill_percent
        string calibration_version
        datetime evidence_until
        datetime updated_at
    }

    COIN_BOX_RESET {
        string coin_box_reset_id PK
        string branch_id FK
        string machine_id FK
        string performed_by_user_id FK
        string reset_source
        string source_event_id
        datetime reset_at
    }

    ALERT_RULE {
        string alert_rule_id PK
        string tenant_id FK
        string branch_id FK
        string rule_type
        string rule_version
        int cooldown_seconds
        boolean enabled
        datetime updated_at
    }

    ALERT_EVENT {
        string alert_event_id PK
        string alert_rule_id FK
        string branch_id FK
        string machine_id FK
        string gas_sensor_id FK
        string acknowledged_by_user_id FK
        string dedupe_key
        string severity
        string evidence_json
        string status
        datetime triggered_at
        datetime acknowledged_at
    }

    ALERT_DELIVERY {
        string alert_delivery_id PK
        string alert_event_id FK
        string channel
        string recipient_ref
        int attempt_number
        string delivery_status
        string provider_message_id
        datetime attempted_at
    }

    AUDIT_LOG {
        string audit_log_id PK
        string tenant_id FK
        string branch_id FK
        string actor_user_id FK
        string action
        string target_type
        string target_id
        string outcome
        datetime created_at
    }

    AI_REQUEST {
        string ai_request_id PK
        string tenant_id FK
        string user_id FK
        string prompt_redacted
        string status
        datetime requested_at
        datetime completed_at
    }

    AI_TOOL_CALL {
        string ai_tool_call_id PK
        string ai_request_id FK
        string tenant_id FK
        string tool_name
        string sanitized_arguments
        string branch_scope_json
        string result_ref
        string status
        datetime called_at
    }
```

### ER design notes

- Optional foreign keys represent records that may apply tenant-wide or may
  target different entity types. Physical migrations must make nullability and
  database constraints explicit.
- `paid_satang` and `amount_satang` are integer currency values. The meaning and
  reset behavior of a machine's paid counter must remain versioned evidence;
  the model does not assume it is universally per-cycle or lifetime cumulative.
- `COIN_BOX_ESTIMATE` is a calibrated estimate. A reset must come from a verified
  mapped event or an authorized manual action with an audit record.
- `GAS_PRESSURE_EVENT` supports low-gas trend estimation. It is not evidence of
  gas-leak detection and must not be presented as a life-safety signal.
- `MACHINE_SNAPSHOT` is replaceable latest state. Historical analysis must use
  source and derived events rather than snapshots.
- `AI_TOOL_CALL` stores allow-listed function usage and authorized scope. The
  assistant must never generate or execute arbitrary SQL.

## Activity Diagram 1: MQTT Telemetry Ingestion and Digital Twin Update

```mermaid
flowchart TD
    subgraph EDGE["Existing Branch Edge"]
        TI_START(["Telemetry sample generated"]) --> TI_PUBLISH["Publish MQTT payload"]
    end

    subgraph CLOUD["Cloud Ingestion"]
        TI_PUBLISH --> TI_AUTH{"Broker authentication valid?"}
        TI_AUTH -- "No" --> TI_SECURITY["Reject connection and record security event"]
        TI_SECURITY --> TI_STOP(["Stop processing"])
        TI_AUTH -- "Yes" --> TI_RECEIVE["Receive payload"]
        TI_RECEIVE --> TI_ENVELOPE{"Required envelope valid?"}
        TI_ENVELOPE -- "No" --> TI_REJECT["Store ingestion rejection and reason"]
        TI_ENVELOPE -- "Yes" --> TI_IDENTITY{"Known tenant, branch, machine, and register map?"}
        TI_IDENTITY -- "No" --> TI_REJECT
        TI_IDENTITY -- "Yes" --> TI_DUPLICATE{"Event ID or payload hash already stored?"}
        TI_DUPLICATE -- "Yes" --> TI_DUP_LOG["Record duplicate outcome"]
        TI_DUP_LOG --> TI_STOP
        TI_DUPLICATE -- "No" --> TI_DECODE["Decode registers with versioned map"]
        TI_DECODE --> TI_NORMALIZE["Normalize units and validate ranges"]
        TI_NORMALIZE --> TI_VALID{"Normalized event valid?"}
        TI_VALID -- "No" --> TI_REJECT
        TI_REJECT --> TI_STOP
        TI_VALID -- "Yes" --> TI_PERSIST["Persist immutable telemetry event"]
        TI_PERSIST --> TI_SNAPSHOT["Update latest machine snapshot"]
        TI_PERSIST --> TI_DERIVE["Derive cycle, payment, pressure, or coin-box evidence"]
        TI_SNAPSHOT --> TI_STREAM["Publish branch-scoped stream event"]
        TI_DERIVE --> TI_RULES["Queue versioned alert-rule evaluation"]
    end

    subgraph DASHBOARD["Authorized Dashboard"]
        TI_STREAM --> TI_SUB_AUTH{"Subscription remains authorized?"}
        TI_SUB_AUTH -- "No" --> TI_CLOSE["Close stream and audit denial"]
        TI_SUB_AUTH -- "Yes" --> TI_UPDATE["Update Digital Twin and last-updated time"]
        TI_UPDATE --> TI_FRESH{"Snapshot inside stale threshold?"}
        TI_FRESH -- "No" --> TI_STALE["Show stale or offline state"]
        TI_FRESH -- "Yes" --> TI_RENDER["Show verified machine state"]
    end

    TI_RULES --> TI_ALERT_NEXT(["Continue to alert workflow"])
```

## Activity Diagram 2: Dashboard Access and Branch-Scoped RBAC

```mermaid
flowchart TD
    subgraph BROWSER["User and Browser"]
        RB_START(["User opens dashboard"]) --> RB_SIGNIN["Submit sign-in or LIFF identity"]
        RB_SCOPE["Select tenant and authorized branch scope"] --> RB_REQUEST["Request dashboard resource"]
        RB_RESPONSE["Receive scoped data with last-updated timestamps"] --> RB_RENDER["Render permitted KPIs, alerts, and machine states"]
        RB_RENDER --> RB_SUBSCRIBE["Open branch-scoped stream subscription"]
        RB_LIVE["Apply live update and refresh last-updated time"]
    end

    subgraph API["API Authorization"]
        RB_SIGNIN --> RB_AUTH{"Authentication valid?"}
        RB_AUTH -- "No" --> RB_UNAUTH["Return authentication error"]
        RB_AUTH -- "Yes" --> RB_MEMBERSHIP["Load active memberships and roles"]
        RB_MEMBERSHIP --> RB_SCOPE
        RB_REQUEST --> RB_SESSION{"Session still valid?"}
        RB_SESSION -- "No" --> RB_UNAUTH
        RB_SESSION -- "Yes" --> RB_BRANCH{"Requested tenant and branches authorized?"}
        RB_BRANCH -- "No" --> RB_DENY["Return forbidden and write audit log"]
        RB_BRANCH -- "Yes" --> RB_ROLE{"Role permits requested operation and fields?"}
        RB_ROLE -- "No" --> RB_DENY
        RB_ROLE -- "Yes" --> RB_QUERY["Build server-side tenant and branch predicates"]
        RB_SUBSCRIBE --> RB_STREAM_AUTH{"Stream scope remains authorized?"}
        RB_STREAM_AUTH -- "No" --> RB_CLOSE["Close stream and audit denial"]
        RB_STREAM_AUTH -- "Yes" --> RB_STREAM["Send authorized machine updates"]
        RB_STREAM --> RB_LIVE
        RB_LIVE --> RB_STREAM_AUTH
    end

    subgraph DATA["Data Access"]
        RB_QUERY --> RB_READ["Read snapshots, KPIs, and active alerts"]
        RB_READ --> RB_FIELDS["Apply role-based field policy"]
        RB_FIELDS --> RB_RESPONSE
    end

    RB_UNAUTH --> RB_END(["Access ends"])
    RB_DENY --> RB_END
```

## Activity Diagram 3: Rule-Based Alert Evaluation and LINE Delivery

```mermaid
flowchart TD
    subgraph ENGINE["Rule Engine"]
        AL_START(["Normalized event or derived evidence available"]) --> AL_LOAD["Load active versioned rules for branch and entity"]
        AL_LOAD --> AL_ANY{"Matching rules available?"}
        AL_ANY -- "No" --> AL_END(["Evaluation ends"])
        AL_ANY -- "Yes" --> AL_EVAL["Evaluate next rule and capture evidence"]
        AL_EVAL --> AL_TRIGGERED{"Trigger condition met?"}
        AL_TRIGGERED -- "No" --> AL_MORE{"More matching rules?"}
        AL_TRIGGERED -- "Yes" --> AL_KEY["Build rule, entity, and cooldown dedupe key"]
        AL_KEY --> AL_SUPPRESS{"Open alert or cooldown match exists?"}
        AL_SUPPRESS -- "Yes" --> AL_SUPPRESS_LOG["Record suppressed duplicate outcome"]
        AL_SUPPRESS_LOG --> AL_MORE
        AL_SUPPRESS -- "No" --> AL_CREATE["Create durable alert with rule version and evidence"]
        AL_CREATE --> AL_RECIPIENTS["Resolve authorized recipients by branch and role"]
        AL_RECIPIENTS --> AL_QUEUE["Queue LINE delivery jobs"]
        AL_CREATE --> AL_DASHBOARD["Publish alert to authorized dashboard"]
        AL_QUEUE --> AL_MORE
        AL_MORE -- "Yes" --> AL_EVAL
        AL_MORE -- "No" --> AL_END
    end

    subgraph DELIVERY["Delivery Worker"]
        AL_QUEUE --> AL_SEND["Send message through LINE Messaging API"]
        AL_SEND --> AL_SENT{"Provider accepted message?"}
        AL_SENT -- "Yes" --> AL_DELIVERED["Store delivered outcome and provider message ID"]
        AL_SENT -- "No" --> AL_FAILED_ATTEMPT["Store failed attempt and error class"]
        AL_FAILED_ATTEMPT --> AL_RETRY{"Retry budget remains?"}
        AL_RETRY -- "Yes" --> AL_REQUEUE["Requeue with bounded backoff"]
        AL_REQUEUE --> AL_SEND
        AL_RETRY -- "No" --> AL_FAILED["Mark delivery failed for operator review"]
    end

    subgraph ALERT_USER["Authorized User"]
        AL_DELIVERED --> AL_RECEIVE["Receive LINE alert"]
        AL_DASHBOARD --> AL_VIEW["View alert and evidence"]
        AL_RECEIVE --> AL_ACK["Request acknowledgement"]
        AL_VIEW --> AL_ACK
        AL_ACK --> AL_ACK_AUTH{"User still authorized for branch?"}
        AL_ACK_AUTH -- "No" --> AL_ACK_DENY["Reject acknowledgement and audit denial"]
        AL_ACK_AUTH -- "Yes" --> AL_ACK_STORE["Store acknowledgement and audit actor"]
    end
```

## Activity Diagram 4: Safe AI Executive Assistant Function Calling

```mermaid
flowchart TD
    subgraph AI_USER["Authorized User"]
        AI_START(["User asks an analytics question"]) --> AI_SUBMIT["Submit prompt with selected tenant context"]
        AI_ANSWER["Receive scoped answer with period, metric, and caveats"] --> AI_END(["Interaction ends"])
    end

    subgraph ORCHESTRATOR["Assistant Orchestrator"]
        AI_SUBMIT --> AI_AUTH{"Session and membership valid?"}
        AI_AUTH -- "No" --> AI_DENY["Reject request and audit denial"]
        AI_AUTH -- "Yes" --> AI_RECORD["Store sanitized request record"]
        AI_RECORD --> AI_INTENT["Classify intent and propose an allow-listed tool"]
        AI_INTENT --> AI_ALLOWED{"Tool is allow-listed?"}
        AI_ALLOWED -- "No" --> AI_UNSUPPORTED["Return unsupported-request response"]
        AI_ALLOWED -- "Yes" --> AI_ARGS["Build structured tool arguments"]
        AI_ARGS --> AI_SCHEMA{"Arguments pass strict schema validation?"}
        AI_SCHEMA -- "No" --> AI_INVALID["Reject invalid arguments and audit outcome"]
        AI_SCHEMA -- "Yes" --> AI_SCOPE{"Tenant and branch scope authorized?"}
        AI_SCOPE -- "No" --> AI_DENY
        AI_TOOL_RESULT["Receive tool result reference and approved aggregates"] --> AI_DATA{"Sufficient traceable data available?"}
        AI_DATA -- "No" --> AI_NO_DATA["Return insufficient-data response"]
        AI_DATA -- "Yes" --> AI_COMPOSE["Compose answer from tool output only"]
        AI_COMPOSE --> AI_AUDIT["Complete request and audit sanitized tool usage"]
        AI_AUDIT --> AI_ANSWER
    end

    subgraph ANALYTICS["Analytics Service"]
        AI_SCOPE -- "Yes" --> AI_EXECUTE["Execute parameterized analytics function"]
        AI_EXECUTE --> AI_LOG_CALL["Store tool name, sanitized arguments, scope, and result reference"]
        AI_LOG_CALL --> AI_TOOL_RESULT
    end

    AI_DENY --> AI_END
    AI_UNSUPPORTED --> AI_END
    AI_INVALID --> AI_END
    AI_NO_DATA --> AI_END
```

## Maintenance rules

- Update the ER diagram when a durable entity, foreign key, or ownership scope
  changes.
- Update the relevant Activity diagram when an authorization, validation,
  failure, retry, or audit decision changes.
- Keep the RTM aligned with these workflows. A diagram does not replace the
  acceptance criteria in `docs/01_requirements/`.
