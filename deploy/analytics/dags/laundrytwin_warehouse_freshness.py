# Airflow DAG: LaundryTwin warehouse freshness monitor
#
# The batch ETL (compose service laundrytwin-etl-1) loads IRIS Postgres data
# into the ClickHouse warehouse every 5 minutes. This DAG is the observability
# companion: it verifies the warehouse is actually receiving fresh data and
# reports table volumes, so a silent ETL failure surfaces in Airflow instead
# of only in docker logs.
#
# Uses the ClickHouse HTTP interface (urllib, stdlib only) so the container
# needs no extra pip packages.

import json
import urllib.parse
import urllib.request
from datetime import timedelta

from pendulum import datetime as pendulum_datetime

from airflow import DAG
from airflow.sdk.exceptions import AirflowFailException
from airflow.providers.standard.operators.python import PythonOperator

default_args = {
    'owner': 'analytics',
    'retries': 2,
    'retry_delay': timedelta(minutes=2),
    'execution_timeout': timedelta(minutes=5),
}

FRESHNESS_LIMIT_MIN = 30


def _query(sql):
    from airflow.models import Variable
    host = Variable.get('clickhouse_host', default_var='analytics-clickhouse-1')
    user = Variable.get('clickhouse_user', default_var='admin')
    password = Variable.get('clickhouse_password', default_var='')
    database = Variable.get('clickhouse_database', default_var='laundrytwin_analytics')
    url = f'http://{host}:8123/'
    params = urllib.parse.urlencode({'query': sql, 'database': database,
                                     'user': user, 'password': password})
    with urllib.request.urlopen(url + '?' + params, timeout=30) as resp:
        body = resp.read().decode().strip()
    return body


def check_usage_freshness(**context):
    body = _query(
        "SELECT dateDiff('minute', max(extracted_at), now()) FROM fact_machine_usage"
    )
    if body == '':
        raise AirflowFailException('fact_machine_usage has no rows at all')
    lag_minutes = int(body)
    if lag_minutes > FRESHNESS_LIMIT_MIN:
        raise AirflowFailException(
            f'Warehouse stale: last extracted_at is {lag_minutes} minutes old '
            f'(limit {FRESHNESS_LIMIT_MIN} min). Check the laundrytwin-etl service.'
        )
    print(f'usage freshness OK: {lag_minutes} min lag')
    return lag_minutes


def check_temperature_freshness(**context):
    body = _query(
        "SELECT dateDiff('minute', max(extracted_at), now()) FROM fact_temperature_sample"
    )
    if body == '':
        raise AirflowFailException('fact_temperature_sample has no rows at all')
    lag_minutes = int(body)
    if lag_minutes > 6 * 60:
        raise AirflowFailException(
            f'Temperature samples stale: last extracted_at is {lag_minutes} minutes old'
        )
    print(f'temperature freshness OK: {lag_minutes} min lag')
    return lag_minutes


def report_warehouse_volumes(**context):
    body = _query(
        "SELECT name, total_rows FROM system.tables "
        "WHERE database = currentDatabase() ORDER BY name FORMAT JSON"
    )
    rows = json.loads(body)['data']
    lines = [f"{r['name']}: {int(r['total_rows']):,} rows" for r in rows]
    print('warehouse volumes:\n' + '\n'.join(lines))
    return lines


with DAG(
    dag_id='laundrytwin_warehouse_freshness',
    default_args=default_args,
    description='Verify the ETL keeps the ClickHouse warehouse fresh',
    schedule='*/5 * * * *',
    start_date=pendulum_datetime(2026, 8, 30),
    catchup=False,
    max_active_runs=1,
    tags=['analytics', 'clickhouse', 'etl', 'monitoring'],
) as dag:
    freshness_usage = PythonOperator(
        task_id='check_usage_freshness',
        python_callable=check_usage_freshness,
    )
    freshness_temperature = PythonOperator(
        task_id='check_temperature_freshness',
        python_callable=check_temperature_freshness,
    )
    volumes = PythonOperator(
        task_id='report_warehouse_volumes',
        python_callable=report_warehouse_volumes,
    )

    [freshness_usage, freshness_temperature] >> volumes
