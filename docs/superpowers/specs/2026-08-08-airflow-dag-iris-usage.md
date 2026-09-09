# Airflow DAG: IRIS Machine Usage to ClickHouse

## DAG: `iris_machine_usage_to_clickhouse`

## Operational status and activation gate (verified 2026-08-14)

The scheduler, triggerer, and DAG processor are healthy, but
`iris_machine_usage_to_clickhouse` is intentionally paused. Five historical
manual runs remain queued and their task instances never started. The
LaundryTwin source endpoint returns HTTP 200 with `rows: []`, `nextCursor:
null`, and an explicit note that the IRIS `machine_usage` endpoint is not
implemented.

ClickHouse currently contains one synthetic `fact_machine_usage` row with
`source_updated_at = 2026-08-09 08:30:00` and `extracted_at = 2026-08-09
08:33:29.424`; machine-event and temperature-sample fact tables contain zero
rows. These values are verification evidence, not production freshness.

Do not unpause the DAG or start a backfill until a direct authenticated source
request returns real rows and a non-null cursor when more pages exist. Then:

1. clear or retire the stale queued manual runs;
2. trigger exactly one new manual run;
3. verify `extract_usage` and `load_to_clickhouse` both complete;
4. verify `iris_usage_cursor` advances only after a successful load;
5. verify ClickHouse row count and maximum `extracted_at` increase;
6. only then enable the five-minute schedule.

An empty successful response is not proof of a healthy ingestion pipeline.
Never fabricate rows, advance the cursor after a failed load, or substitute a
timestamp-only cursor for `(updated_at, usage_id)`.

### Purpose
Incrementally extract machine usage data from final-project API and upsert into ClickHouse `fact_machine_usage` table.

### Schedule
- Every 5 minutes (`*/5 * * * *`)
- Catchup: False (only current window)
- Max active runs: 1

### Configuration
Airflow Variables (set in UI or via CLI):
```json
{
  "laundrytwin_api_base": "https://laundrytwin.duckdns.org",
  "laundrytwin_api_key": "<analytics-read-api-key>",
  "clickhouse_host": "10.10.0.117",
  "clickhouse_port": "9009",
  "clickhouse_user": "admin",
  "clickhouse_password": "<from-.env>",
  "clickhouse_database": "laundrytwin_analytics"
}
```

### Incremental Cursor Logic

Cursor state stored in Airflow Variable `iris_usage_cursor`:
```json
{
  "updated_at": "2026-08-08T10:00:00.000Z",
  "usage_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
}
```

Query parameters:
- `updated_after` = cursor.updated_at
- `after_id` = cursor.usage_id
- `limit` = 2000

### DAG Structure

```python
from datetime import datetime, timedelta
import json
import requests
from clickhouse_driver import Client
from airflow import DAG
from airflow.models import Variable
from airflow.operators.python import PythonOperator
from airflow.utils.dates import days_ago

default_args = {
    'owner': 'analytics',
    'retries': 3,
    'retry_delay': timedelta(minutes=2),
    'execution_timeout': timedelta(minutes=10),
}

with DAG(
    dag_id='iris_machine_usage_to_clickhouse',
    default_args=default_args,
    description='Incremental IRIS machine usage to ClickHouse',
    schedule_interval='*/5 * * * *',
    start_date=days_ago(1),
    catchup=False,
    max_active_runs=1,
    tags=['analytics', 'iris', 'clickhouse'],
) as dag:

    def extract_usage(**context):
        """Pull usage rows from final-project API."""
        api_base = Variable.get('laundrytwin_api_base', deserialize_json=False)
        api_key = Variable.get('laundrytwin_api_key', deserialize_json=False)
        cursor = Variable.get('iris_usage_cursor', default_var=None, deserialize_json=True)

        params = {'limit': 2000}
        if cursor:
            params['updated_after'] = cursor['updated_at']
            params['after_id'] = cursor['usage_id']

        headers = {'X-Analytics-Read-Key': api_key}
        url = f'{api_base}/api/analytics/machine-usage'

        resp = requests.get(url, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
        data = resp.json()

        rows = data.get('rows', [])
        next_cursor = data.get('nextCursor')

        context['ti'].xcom_push(key='usage_rows', value=rows)
        context['ti'].xcom_push(key='next_cursor', value=next_cursor)
        return len(rows)

    def load_to_clickhouse(**context):
        """Upsert rows into ClickHouse."""
        rows = context['ti'].xcom_pull(key='usage_rows', task_ids='extract_usage')
        next_cursor = context['ti'].xcom_pull(key='next_cursor', task_ids='extract_usage')

        if not rows:
            return 'No rows to load'

        ch_host = Variable.get('clickhouse_host')
        ch_port = int(Variable.get('clickhouse_port'))
        ch_user = Variable.get('clickhouse_user')
        ch_pass = Variable.get('clickhouse_password')
        ch_db = Variable.get('clickhouse_database')

        client = Client(
            host=ch_host,
            port=ch_port,
            user=ch_user,
            password=ch_pass,
            database=ch_db,
        )

        # Prepare batch insert
        data = []
        for r in rows:
            data.append((
                r['tenantId'], r['branchId'], r['machineId'], r['usageId'],
                r['sourceEventId'], r.get('machineSessionId'),
                r.get('startedAt'), r.get('finishedAt'),
                r['durationMin'], r['programId'], r['programName'],
                r.get('tempLevel'), r['amountSatang'],
                r['status'], r.get('initiatedVia'),
                r.get('attributionState'), r.get('attributionSource'),
                r['sourceCreatedAt'], r['sourceUpdatedAt'],
                datetime.utcnow().isoformat()
            ))

        client.execute(
            '''
            INSERT INTO fact_machine_usage (
                tenant_id, branch_id, machine_id, usage_id,
                source_event_id, machine_session_id,
                started_at, finished_at,
                duration_min, program_id, program_name,
                temp_level, amount_satang,
                status, initiated_via,
                attribution_state, attribution_source,
                source_created_at, source_updated_at,
                extracted_at
            ) VALUES
            ''',
            data
        )

        # Update cursor if we got rows
        if next_cursor:
            # Decode cursor to get updated_at and usage_id for next run
            import base64
            decoded = base64.b64decode(next_cursor).decode()
            updated_at, usage_id = decoded.split('|', 1)
            Variable.set('iris_usage_cursor',
                         json.dumps({'updated_at': updated_at, 'usage_id': usage_id}))

        return f'Loaded {len(rows)} rows'

    extract = PythonOperator(
        task_id='extract_usage',
        python_callable=extract_usage,
    )

    load = PythonOperator(
        task_id='load_to_clickhouse',
        python_callable=load_to_clickhouse,
    )

    extract >> load
```

### Initial Backfill DAG

Separate DAG `iris_machine_usage_backfill`:
- Manual trigger only
- Iterates from epoch or configurable start date
- Uses same cursor logic but runs sequentially
- Processes in 2000-row batches until empty

```python
with DAG(
    dag_id='iris_machine_usage_backfill',
    default_args=default_args,
    description='One-time backfill of IRIS machine usage',
    schedule_interval=None,
    start_date=days_ago(1),
    catchup=False,
    max_active_runs=1,
) as dag:

    def backfill_batch(**context):
        cursor = Variable.get('iris_backfill_cursor', default_var=None, deserialize_json=True)
        # ... same extract/load logic but updates iris_backfill_cursor
        # Stops when API returns empty rows

    # Run in a loop via PythonOperator with while loop or
    # use TriggerDagRunOperator to chain batches
```

### Requirements

Add to Airflow container:
```
clickhouse-driver==0.2.6
requests==2.32.3
```

Can be installed via `requirements.txt` in DAGs folder or custom Airflow image.

### Monitoring

- Airflow UI: Task duration, retry count
- ClickHouse: `SELECT count(), max(source_updated_at) FROM fact_machine_usage`
- Logs: Search for `Loaded X rows` / `No rows to load`

### Alerting (future)
- Alert if DAG fails 3 consecutive runs
- Alert if `max(source_updated_at)` > 1 hour old