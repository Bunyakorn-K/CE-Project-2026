# ClickHouse Schema for LaundryTwin Machine Usage Analytics

## Database: `laundrytwin_analytics`

### dim_branch
```sql
CREATE TABLE IF NOT EXISTS dim_branch (
    tenant_id UUID,
    branch_id UUID,
    branch_name String,
    timezone String,
    active UInt8,
    source_updated_at DateTime64(3),
    extracted_at DateTime64(3)
) ENGINE = ReplacingMergeTree(source_updated_at)
ORDER BY (tenant_id, branch_id);
```

### dim_machine
```sql
CREATE TABLE IF NOT EXISTS dim_machine (
    tenant_id UUID,
    branch_id UUID,
    machine_id UUID,
    machine_code String,
    machine_kind Enum8('washer' = 1, 'dryer' = 2),
    modbus_address UInt16,
    active UInt8,
    source_updated_at DateTime64(3),
    extracted_at DateTime64(3)
) ENGINE = ReplacingMergeTree(source_updated_at)
ORDER BY (tenant_id, branch_id, machine_id);
```

### fact_machine_usage
```sql
CREATE TABLE IF NOT EXISTS fact_machine_usage (
    tenant_id UUID,
    branch_id UUID,
    machine_id UUID,
    usage_id UUID,
    source_event_id String,
    machine_session_id Nullable(String),
    started_at Nullable(DateTime64(3)),
    finished_at Nullable(DateTime64(3)),
    duration_min UInt16,
    program_id UInt16,
    program_name String,
    temp_level Nullable(Enum8('cold' = 1, 'warm' = 2, 'hot' = 3, 'low' = 4, 'medium' = 5, 'high' = 6)),
    amount_satang Int64,
    status Enum8('pending_payment' = 1, 'paid' = 2, 'running' = 3, 'finished' = 4, 'cancelled' = 5),
    initiated_via Nullable(Enum8('staff_v3' = 1, 'liff' = 2, 'kiosk_k2' = 3)),
    attribution_state Nullable(Enum8('exact' = 1, 'legacy' = 2, 'heuristic' = 3, 'pending_attribution' = 4)),
    attribution_source Nullable(Enum8('staff_v3' = 1, 'liff' = 2, 'handheld_dispatch' = 3, 'unknown' = 4)),
    source_created_at DateTime64(3),
    source_updated_at DateTime64(3),
    extracted_at DateTime64(3)
) ENGINE = ReplacingMergeTree(source_updated_at)
ORDER BY (tenant_id, branch_id, started_at, usage_id)
PARTITION BY toYYYYMM(started_at)
SETTINGS index_granularity = 8192;
```

### fact_machine_event
```sql
CREATE TABLE IF NOT EXISTS fact_machine_event (
    tenant_id UUID,
    branch_id UUID,
    machine_id String,
    event_id String,
    seq UInt64,
    frame_seq Nullable(UInt64),
    occurred_at DateTime64(3),
    ingested_at DateTime64(3),
    kind Enum8('state_change' = 1, 'command_executed' = 2, 'error' = 3, 'offline_detected' = 4),
    phase Nullable(Enum8('IDLE' = 1, 'PAID' = 2, 'RUNNING' = 3, 'FINISHED' = 4, 'ERROR' = 5, 'OFFLINE' = 6, 'MAINTENANCE' = 7, 'ARMED' = 8, 'RUN_HEAT' = 9, 'RUN_COOL' = 10, 'POST_CYCLE' = 11)),
    prev_phase Nullable(String),
    state_raw String,
    extracted_at DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (tenant_id, branch_id, occurred_at, event_id)
PARTITION BY toYYYYMM(occurred_at)
SETTINGS index_granularity = 8192;
```

### fact_temperature_sample
```sql
CREATE TABLE IF NOT EXISTS fact_temperature_sample (
    tenant_id UUID,
    branch_id UUID,
    machine_id String,
    event_id String,
    seq UInt64,
    frame_seq Nullable(UInt64),
    occurred_at DateTime64(3),
    ingested_at DateTime64(3),
    temperature_f Int16,
    temperature_c Nullable(Float32),
    phase Nullable(String),
    extracted_at DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (tenant_id, branch_id, occurred_at, event_id)
PARTITION BY toYYYYMM(occurred_at)
SETTINGS index_granularity = 8192;
```

### fact_audit_event
```sql
CREATE TABLE IF NOT EXISTS fact_audit_event (
    tenant_id UUID,
    branch_id UUID,
    machine_id String,
    event_id String,
    event_kind Enum8('command_executed' = 1, 'coin_inserted' = 2, 'coinbox_opened' = 3, 'coinbox_closed' = 4),
    occurred_at DateTime64(3),
    ingested_at DateTime64(3),
    metadata String,
    extracted_at DateTime64(3)
) ENGINE = MergeTree()
ORDER BY (tenant_id, branch_id, occurred_at, event_id)
PARTITION BY toYYYYMM(occurred_at)
SETTINGS index_granularity = 8192;
```

## Migration Script

```bash
# On the analytics VM (10.10.0.117)
cat > /tmp/init_clickhouse.sql << 'EOF'
CREATE DATABASE IF NOT EXISTS laundrytwin_analytics;
EOF

# Run migrations
curl -X POST "http://127.0.0.1:8123/" \
  -u "admin:${CLICKHOUSE_PASSWORD}" \
  --data-binary @/tmp/init_clickhouse.sql

# Then run each table DDL
```

## Notes

- `ReplacingMergeTree` for mutable dimensions/facts (machine_usage status transitions)
- `MergeTree` for append-only event tables
- Partition by month for time-range query performance
- `extracted_at` tracks when Airflow ingested the row
- `source_updated_at` / `occurred_at` preserve original IRIS timestamps
- All satang amounts as Int64
- Temperature: raw °F preserved, °C computed at ingest
- Enum types for status/attribution to save space and enforce validity