# Airflow Dashboard & Monitoring Setup Guide

## Prerequisites
- Airflow running at `https://airflow.laundrytwin.duckdns.org`
- Login: `admin` / `<airflow-admin-password>`
- DAGs: `iris_machine_usage_to_clickhouse` (every 5 min), `iris_machine_usage_backfill` (manual)

## 1. Airflow UI Overview

### Main Dashboard (Home)
- **DAGs view**: Lists all DAGs with status, last run, next run
- **Graph view**: Visual DAG structure and task dependencies
- **Grid view**: Task instance status grid by date
- **Task Duration**: Task execution time trends

### Key DAGs
| DAG ID | Schedule | Purpose |
|--------|----------|---------|
| `iris_machine_usage_to_clickhouse` | `*/5 * * * *` | Incremental sync every 5 min |
| `iris_machine_usage_backfill` | Manual | One-time historical backfill |

## 2. Monitoring DAG Runs

### DAG Run States
- **success**: All tasks completed successfully
- **running**: DAG currently executing
- **failed**: One or more tasks failed
- **queued**: Waiting for scheduler to pick up
- **upstream_failed**: Upstream task failed

### Checking DAG Run History
```bash
# Via Airflow UI
1. Go to DAGs → iris_machine_usage_to_clickhouse
2. Click "Graph View" → see task status per run
3. Click "Grid View" → see all runs in calendar

# Via CLI (on analytics VM)
sudo docker exec analytics-airflow-1 airflow dags list-runs iris_machine_usage_to_clickhouse
```

### Checking Task Instance States
```bash
# All task instances for a DAG
sudo docker exec analytics-airflow-1 python3 -c "
from airflow.models import TaskInstance
from airflow.utils.session import provide_session

@provide_session
def check_tis(session=None):
    tis = session.query(TaskInstance).filter(
        TaskInstance.dag_id == 'iris_machine_usage_to_clickhouse'
    ).all()
    for ti in tis:
        print(f'{ti.task_id} run={ti.run_id} state={ti.state} date={ti.logical_date}')

check_tis()
"
```

## 3. Airflow Variables Configuration

### Current Variables (set via CLI or UI)
```bash
# Set via CLI
sudo docker exec analytics-airflow-1 airflow variables set laundrytwin_api_base "http://10.10.0.117:8080"
sudo docker exec analytics-airflow-1 airflow variables set laundrytwin_api_key "<analytics-read-api-key>"
sudo docker exec analytics-airflow-1 airflow variables set clickhouse_host "10.10.0.117"
sudo docker exec analytics-airflow-1 airflow variables set clickhouse_port "9009"
sudo docker exec analytics-airflow-1 airflow variables set clickhouse_user "admin"
sudo docker exec analytics-airflow-1 airflow variables set clickhouse_password "<clickhouse-password>"
sudo docker exec analytics-airflow-1 airflow variables set clickhouse_database "laundrytwin_analytics"
```

### Via Airflow UI
1. **Admin → Variables → +**
2. Add each key/value pair above
3. For sensitive values (passwords), use **Secret** backend or encrypt

### Variable Descriptions
| Variable | Description | Example |
|----------|-------------|---------|
| `laundrytwin_api_base` | Final-project API base URL (internal) | `http://10.10.0.117:8080` |
| `laundrytwin_api_key` | Analytics read API key (X-Analytics-Read-Key) | `<analytics-read-api-key>` |
| `clickhouse_host` | ClickHouse host | `10.10.0.117` |
| `clickhouse_port` | ClickHouse HTTP port | `9009` (or `8123` for HTTP) |
| `clickhouse_user` | ClickHouse username | `admin` |
| `clickhouse_password` | ClickHouse password | From `.env` |
| `clickhouse_database` | ClickHouse database name | `laundrytwin_analytics` |

### Cursor Variables (auto-managed by DAG)
| Variable | Description |
|----------|-------------|
| `iris_usage_cursor` | Incremental sync cursor: `{"updated_at": "...", "usage_id": "..."}` |
| `iris_backfill_cursor` | Backfill cursor (manual DAG) |
| `iris_backfill_complete` | Backfill completion marker |

## 4. Connections

### ClickHouse Connection (optional - for operators)
1. **Admin → Connections → +**
2. **Conn Id**: `clickhouse_default`
3. **Conn Type**: `ClickHouse` (or `HTTP` if not available)
4. **Host**: `10.10.0.117`
5. **Port**: `8123`
6. **Login**: `admin`
6. **Password**: `<clickhouse-password>`
7. **Schema**: `laundrytwin_analytics`

### HTTP Connection for API calls
1. **Conn Id**: `laundrytwin_api`
2. **Conn Type**: `HTTP`
3. **Host**: `http://10.10.0.117:8080`
4. **Headers** (JSON):
```json
{
  "X-Analytics-Read-Key": "{{ var.value.laundrytwin_api_key }}"
}
```

## 5. Alerting & Monitoring

### Task Failure Alerts (email/slack)
1. **Admin → Connections → Slack** (or Email)
2. Configure **Alerting** in DAG:
```python
default_args = {
    'owner': 'analytics',
    'retries': 3,
    'retry_delay': timedelta(minutes=2),
    'execution_timeout': timedelta(minutes=10),
    'on_failure_callback': send_alert,  # custom function
}
```

### Custom Alert Function Example
```python
def send_alert(context):
    import requests
    task = context['task_instance']
    dag_id = task.dag_id
    task_id = task.task_id
    error = context.get('exception')

    message = f"""
    🚨 Airflow Task Failed
    DAG: {dag_id}
    Task: {task_id}
    Run: {task.run_id}
    Error: {error}
    """

    # Send to Slack webhook
    requests.post(
        "https://hooks.slack.com/services/...",
        json={"text": message}
    )
```

### SLA Monitoring
```python
from airflow.utils.dates import days_ago

with DAG(
    dag_id='iris_machine_usage_to_clickhouse',
    default_args=default_args,
    schedule='*/5 * * * *',
    start_date=pendulum_datetime(2026, 8, 1),
    sla_miss_callback=send_sla_alert,  # alert if DAG exceeds SLA
) as dag:
    ...
```

## 5. Monitoring Commands

### Check Scheduler Health
```bash
sudo docker exec analytics-airflow-1 airflow scheduler --help
# or check logs
sudo docker logs analytics-airflow-1 | grep -i scheduler | tail -20
```

### Check DAG Parse Errors
```bash
sudo docker exec analytics-airflow-1 airflow dags list-import-errors
```

### Check Task Queue
```bash
sudo docker exec analytics-airflow-1 python3 -c "
from airflow.models import TaskInstance
from airflow.utils.state import State
from airflow.utils.session import provide_session

@provide_session
def check_queue(session=None):
    queued = session.query(TaskInstance).filter(
        TaskInstance.state == State.QUEUED
    ).all()
    print(f'Queued tasks: {len(queued)}')
    for ti in queued:
        print(f'  {ti.dag_id}.{ti.task_id} run={ti.run_id}')

check_queue()
"
```

### Trigger DAG Manually
```bash
# Trigger incremental DAG
sudo docker exec analytics-airflow-1 airflow dags trigger iris_machine_usage_to_clickhouse

# Trigger backfill with date
sudo docker exec analytics-airflow-1 airflow dags trigger iris_machine_usage_backfill --logical-date 2026-08-01
```

### Clear Stuck Tasks
```bash
# Clear specific task instance
sudo docker exec analytics-airflow-1 airflow tasks clear iris_machine_usage_to_clickhouse -t extract_usage -r manual__2026-08-09T08:02:45

# Clear all tasks for a DAG run
sudo docker exec analytics-airflow-1 airflow tasks clear iris_machine_usage_to_clickhouse -r manual__2026-08-09T08:02:45
```

## 6. Performance Tuning

### Scheduler Configuration
```bash
# Check current config
sudo docker exec analytics-airflow-1 airflow config get-value core scheduler_heartbeat_sec
sudo docker exec analytics-airflow-1 airflow config get-value core dag_dir_list_interval
```

### Recommended Settings (in airflow.cfg or env vars)
```bash
AIRFLOW__SCHEDULER__SCHEDULER_HEARTBEAT_SEC=10
AIRFLOW__SCHEDULER__DAG_DIR_LIST_INTERVAL=30
AIRFLOW__SCHEDULER__PARSING_PROCESSES=2
AIRFLOW__CORE__PARALLELISM=32
AIRFLOW__CORE__MAX_ACTIVE_RUNS_PER_DAG=1
```

### For LocalExecutor (current)
```bash
AIRFLOW__CORE__EXECUTOR=LocalExecutor
```

## 7. Useful Airflow UI Links

| View | URL Path |
|------|----------|
| DAG List | `/dags` |
| DAG Graph | `/dags/iris_machine_usage_to_clickhouse/graph` |
| Grid View | `/dags/iris_machine_usage_to_clickhouse/grid` |
| Task Duration | `/dags/iris_machine_usage_to_clickhouse/duration` |
| Gantt Chart | `/dags/iris_machine_usage_to_clickhouse/gantt` |
| Code View | `/dags/iris_machine_usage_to_clickhouse/code` |
| Variables | `/variable/list` |
| Connections | `/connection/list` |
| Import Errors | `/import-errors/list` |

## 8. Troubleshooting

### DAG Stays in "queued" State
1. Check scheduler is running: `sudo docker logs analytics-airflow-1 | grep scheduler`
2. Check task slots available: LocalExecutor runs one task at a time per DAG
3. Clear stuck tasks and re-trigger

### ClickHouse Connection Failed
1. Verify ClickHouse is healthy: `curl http://10.10.0.117:8123/ping`
2. Check credentials in Airflow Variables
3. Test from Airflow container: `docker exec analytics-airflow-1 python3 -c "import clickhouse_connect; ..."`

### API 401/403 Errors
1. Verify `laundrytwin_api_key` matches `ANALYTICS_READ_API_KEY` in final-project
2. Check final-project API health: `curl http://10.10.0.117:8080/health`

### Backfill Not Running
1. Check `iris_backfill_cursor` variable exists
2. Ensure DAG is not paused
3. Trigger manually with logical date

---

**Airflow URL**: `https://airflow.laundrytwin.duckdns.org`
**Auth**: Authentik SSO (group: final project member)
**Admin Credentials**: `admin` / `<airflow-admin-password>`