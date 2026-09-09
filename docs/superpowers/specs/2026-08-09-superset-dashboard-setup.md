# Superset Dashboard Setup Manual

## Verified automated import

## Verified live-data and chart constraints (2026-08-14)

The dashboard is operational, but its current usage data is not a live IRIS
feed. `fact_machine_usage` contains one synthetic verification row and the
upstream machine-usage export is not implemented. Empty charts must remain
empty or visibly identified as verification data; do not relabel synthetic
data as branch production data.

Superset 6.1 `heatmap_v2` uses the native singular-field contract. The live
`Utilization Heatmap` was repaired to use:

```json
{
  "viz_type": "heatmap_v2",
  "x_axis": "started_at",
  "time_grain_sqla": "PT1H",
  "groupby": ["machine_id"],
  "metric": "total_duration_min",
  "time_range": "Last 7 days"
}
```

Do not import or hand-create the legacy shape with `metrics: [...]` and no
`x_axis`. Superset calls `getMetricLabel(formData.metric)` and that legacy shape
fails with `Cannot read properties of undefined (reading 'label')`. A valid
chart-data response must include both axes and the value column:
`started_at`, `machine_id`, and `total_duration_min`.

Any future hour-of-day by weekday heatmap requires approved derived-column
semantics. Do not infer those dimensions silently from timestamps.

The repository's generated JSON export is not a valid Superset 6.1 import bundle. Use the verified ZIP package `/Users/uunw/superset_laundrytwin_verified_import.zip` instead. It contains two official Superset exports and `README.md` with the import order and runtime requirements.

1. Import `laundrytwin_verified_datasources.zip` first from **Data → Import Data**.
2. Import `laundrytwin_verified_dashboard.zip` from **Dashboards → Import**.
3. Open **LaundryTwin Analytics** and verify the seven charts.

The dashboard ZIP was exported after associating all seven charts with dashboard ID 2. The official archive contains versioned YAML, metadata, seven chart objects, the dashboard layout, the database, and the referenced datasets. Import datasources before dashboards when targeting another Superset instance so UUID references can be remapped.

Superset requires the `clickhouse-connect` SQLAlchemy dialect. The verified runtime used `clickhouse-connect==1.6.0` and the URI `clickhousedb://admin:<password>@analytics-clickhouse-1:8123/laundrytwin_analytics`. Persist this dependency in the Superset image or Compose requirements before recreating the container; installing it only in a running container is not durable.

The package excludes all passwords. Do not commit live credentials or the package to the repository.

# Superset Dashboard Manual Setup Guide

## Prerequisites
- Superset running at `https://superset.laundrytwin.duckdns.org`
- Log in with the environment-provided admin credential.
- ClickHouse database `laundrytwin_analytics` with tables already created.

## 1. Add ClickHouse Database

1. Go to **Settings → Database Connections → + DATABASE**.
2. Fill in:
   - **Database Name**: `laundrytwin_analytics`
   - **SQLAlchemy URI**: `clickhousedb://admin:<password>@analytics-clickhouse-1:8123/laundrytwin_analytics`
   - Check: `Expose in SQL Lab`, `Allow CTA`, `Allow CVAS`, `Allow DML`.
3. Click **Test Connection** → should succeed.
4. Click **Add**.
3. Click **Test Connection** → should succeed
4. Click **Add**

## 2. Add Datasets

### 2.1 fact_machine_usage (main fact table)
1. **Data → Datasets → + DATASET**
2. **Database**: `laundrytwin_analytics`
3. **Schema**: `laundrytwin_analytics`
4. **Table**: `fact_machine_usage`
5. Click **Add**
6. In dataset detail, set column types:
   - `tenant_id`, `branch_id`, `machine_id`, `usage_id`: UUID
   - `started_at`, `finished_at`, `source_created_at`, `source_updated_at`, `extracted_at`: TIMESTAMP
   - `amount_satang`: BIGINT
   - `status`: Enum (pending_payment, paid, running, finished, cancelled)
   - `attribution_state`, `attribution_source`: Enum
   - `duration_min`, `program_id`: INT
   - `program_name`, `temp_level`, `initiated_via`: VARCHAR

### 2.2 dim_branch
- Table: `dim_branch`
- Key columns: `branch_id` (UUID), `branch_name`, `timezone`

### 2.3 dim_machine
- Table: `dim_machine`
- Key columns: `machine_id` (UUID), `machine_code`, `machine_kind` (washer/dryer), `modbus_address`

### 2.4 fact_machine_event, fact_temperature_sample, fact_audit_event
- Add similarly for operational dashboards

## 3. Create Charts

### 3.1 Revenue by Day (Bar Chart)
- **Dataset**: `fact_machine_usage`
- **Chart Type**: Bar Chart
- **Time Column**: `started_at`
- **Time Grain**: Day
- **Metric**: `SUM(amount_satang)` → format as Baht (divide by 100)
- **Filters**: `status IN ('finished', 'paid')`

### 3.2 Cycles by Day (Line Chart)
- **Dataset**: `fact_machine_usage`
- **Chart Type**: Line Chart
- **Time Column**: `started_at`
- **Time Grain**: Day
- **Metric**: `COUNT(*)` (cycles)
- **Series**: `branch_name` (join with dim_branch)

### 3.3 Utilization Heatmap (`heatmap_v2`)

- **Dataset**: `fact_machine_usage`
- **X axis**: `started_at`
- **Time grain**: `PT1H` (Hour)
- **Y axis**: `machine_id`
- **Metric**: singular `metric: total_duration_min`

This deployed chart shows hourly duration by machine. It is structurally
verified against the synthetic smoke-test row only. Do not configure
hour-of-day or day-of-week derived dimensions until their timezone and
aggregation semantics are approved in the data contract.
### 3.4 Machine Cycles by Program (Pie Chart)
- **Dataset**: `fact_machine_usage`
- **Chart Type**: Pie Chart
- **Metric**: `COUNT(*)`
- **Group By**: `program_name`

### 3.5 Revenue by Attribution (Stacked Bar)
- **Dataset**: `fact_machine_usage`
- **Chart Type**: Bar Chart (stacked)
- **Time Column**: `started_at`
- **Time Grain**: Day
- **Series**: `attribution_state` (exact, heuristic, pending_attribution, legacy)
- **Metric**: `SUM(amount_satang)`

### 3.6 Average Cycle Duration (Line Chart)
- **Dataset**: `fact_machine_usage`
- **Chart Type**: Line Chart
- **Time Column**: `started_at`
- **Time Grain**: Day
- **Metric**: `AVG(duration_min)`
- **Series**: `machine_kind` (join dim_machine)

### 3.7 Top 10 Machines by Cycles (Table)
- **Dataset**: `fact_machine_usage` joined with `dim_machine`
- **Chart Type**: Table
- **Columns**: `machine_code`, `branch_name`, `COUNT(*) as cycles`, `SUM(amount_satang) as revenue`
- **Sort**: `cycles` DESC
- **Row Limit**: 10

### 3.8 Temperature Curve (Line Chart) - Dryer Only
- **Dataset**: `fact_temperature_sample` joined with `dim_machine`
- **Filter**: `machine_kind = 'dryer'`
- **Chart Type**: Line Chart
- **Time Column**: `occurred_at`
- **Metric**: `AVG(temperature_c)` or `temperature_f`
- **Series**: `machine_code`

## 4. Create Dashboard

1. **Dashboards → + DASHBOARD**
2. Name: `LaundryTwin Analytics`
3. Add all charts from above
4. Layout suggestions:
   - Top row: Revenue by Day | Cycles by Day
   - Middle row: Revenue by Attribution | Avg Cycle Duration
   - Bottom row: Utilization Heatmap | Temperature Curve
   - Right sidebar: Top 10 Machines | Cycles by Program

4. Add **Dashboard Filters**:
   - **Date Range**: linked to `started_at` / `occurred_at`
   - **Branch**: filter on `branch_id` (linked to dim_branch)
   - **Machine Kind**: `washer` / `dryer`
   - **Status**: `finished`, `paid`, `running`, etc.

5. Save and set as **default dashboard** for the workspace

## 5. SQL Lab Queries (for ad-hoc analysis)

Save these as **Saved Queries** in SQL Lab:

### Daily Revenue Summary
```sql
SELECT
    toDate(started_at) as date,
    branch_name,
    COUNT(*) as cycles,
    SUM(amount_satang) / 100 as revenue_baht,
    AVG(duration_min) as avg_duration_min
FROM fact_machine_usage
JOIN dim_branch ON fact_machine_usage.branch_id = dim_branch.branch_id
WHERE status IN ('finished', 'paid')
  AND started_at >= now() - INTERVAL 30 DAY
GROUP BY date, branch_name
ORDER BY date DESC, branch_name;
```

### Machine Utilization by Hour
```sql
SELECT
    toHour(started_at) as hour,
    toDayOfWeek(started_at) as dow,
    COUNT(*) as cycles,
    SUM(duration_min) as total_minutes
FROM fact_machine_usage
WHERE started_at >= now() - INTERVAL 7 DAY
GROUP BY hour, dow
ORDER BY dow, hour;
```

### Attribution Breakdown
```sql
SELECT
    toDate(started_at) as date,
    attribution_state,
    COUNT(*) as cycles,
    SUM(amount_satang) / 100 as revenue_baht
FROM fact_machine_usage
WHERE started_at >= now() - INTERVAL 30 DAY
GROUP BY date, attribution_state
ORDER BY date DESC, attribution_state;
```

## 6. Permissions

1. **Settings → List Users → admin → Edit**
2. Assign **Gamma** or **Admin** role
3. For other users: add to **Gamma** role with `laundrytwin_analytics` database access

## 7. Embedding (optional)

For embedding in external apps:
1. **Settings → Feature Flags → EMBEDDED_SUPERSET = True**
2. Create **Guest Token** via API for iframe embedding

---

**Note**: The ClickHouse native protocol (port 8123) is used for Superset. The native port 9009 is for Airflow DAG writes.