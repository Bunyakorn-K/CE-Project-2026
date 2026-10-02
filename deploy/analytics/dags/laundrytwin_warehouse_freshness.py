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
from datetime import date, timedelta

from pendulum import datetime as pendulum_datetime

from airflow import DAG
from airflow.sdk.bases.operator import chain
from airflow.sdk.exceptions import AirflowFailException
from airflow.providers.standard.operators.python import PythonOperator

default_args = {
    'owner': 'analytics',
    'retries': 2,
    'retry_delay': timedelta(minutes=2),
    'execution_timeout': timedelta(minutes=5),
}

FRESHNESS_LIMIT_MIN = 30

# Contiguity check (added 2026-09-30).
#
# WHY THIS EXISTS. On 2026-09-17 the live ClickHouse volume was rolled back to a
# 2026-08-31 snapshot, and 17 days of usage (2026-08-31 -> 2026-09-16) went
# missing. It stayed missing for 13 days and NOTHING alerted, because the two
# existing signals were both blind to it:
#
#   * check_usage_freshness measures max(extracted_at) — RECENCY only. The ETL
#     kept ingesting new rows after the rollback, so the newest row was always
#     minutes old even though the historical middle was gone.
#   * The ETL watermark (/opt/laundrytwin-etl/data/etl-watermark.json) is a
#     forward-only cursor that lives OUTSIDE the ClickHouse volume, so it
#     survived the rollback and the loader never re-read the missing window.
#
# A fresh-but-holey warehouse is exactly the failure a recency check cannot
# see. This check asserts CONTINUITY instead: that the recent window has no
# unexpected day-shaped hole in the business timeline.
#
# It is deliberately a WARN, not a FAIL. A genuine source gap is a real
# possibility and must not page anyone; the 2026-07-27 gap is a known genuine
# source gap, not an artefact. Anything OUTSIDE the known-gap set is a real
# signal worth a human look, so it is reported loudly and the DAG still
# succeeds.
CONTINUITY_LOOKBACK_DAYS = 30

# Day-shaped gaps known to be genuine upstream/source gaps, not warehouse
# faults. Measured 2026-10-02 against IRIS directly: 2026-07-27 holds 5 usage
# rows, all `cancelled`, and NOT ONE of them carries `started_at` — so no reload
# can put a row on that business day. (An earlier comment here said the day had
# "no usage rows in IRIS either", which is false; the conclusion held but the
# evidence did not, and an exemption justified by a fact that is false is one
# nobody re-measures when it stops being load-bearing.)
# Keep this list short and evidence-backed — a growing list here is how a real
# regression gets silenced. `apps/etl` `pnpm coverage` re-derives this answer.
KNOWN_SOURCE_GAP_DAYS = frozenset({'2026-07-27'})


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


def find_missing_days(present_days, start, end):
    """Return the ISO dates in [start, end] that are absent from present_days.

    Pure function, stdlib only, so the rule is reviewable and testable without
    a live ClickHouse. present_days may contain ISO strings or date objects.
    """
    present = {
        d if isinstance(d, date) else date.fromisoformat(str(d))
        for d in present_days
    }
    missing = []
    cursor = start
    while cursor <= end:
        if cursor not in present:
            missing.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return missing


def check_usage_continuity(**context):
    """Report day-shaped holes in the recent business timeline.

    Uses started_at (the business timestamp the row is ABOUT), not
    extracted_at. extracted_at only says when the loader ran; started_at says
    which day of trading the row represents. The 2026-09-17 rollback is only
    visible against started_at.
    """
    # The column is aliased: FORMAT JSON keys rows by the SELECT expression
    # text, not by position, so an unaliased column would come back under a key
    # like 'toString(toDate(started_at))'. Alias it and read the alias.
    body = _query(
        'SELECT toString(toDate(started_at)) AS usage_day '
        'FROM fact_machine_usage FINAL '
        'WHERE started_at IS NOT NULL '
        f'AND started_at >= now() - INTERVAL {CONTINUITY_LOOKBACK_DAYS} DAY '
        'GROUP BY usage_day ORDER BY usage_day FORMAT JSON'
    )
    present = [row['usage_day'] for row in json.loads(body)['data']]

    # Anchor the window on the newest business day present, not on today():
    # today() can legitimately have no rows yet (a branch opens later, or the
    # day is young), and that is not a gap.
    if present:
        end = date.fromisoformat(present[-1])
    else:
        end = pendulum_datetime.now().date()
    start = end - timedelta(days=CONTINUITY_LOOKBACK_DAYS - 1)

    missing = find_missing_days(present, start, end)
    unexpected = [d for d in missing if d not in KNOWN_SOURCE_GAP_DAYS]
    known = [d for d in missing if d in KNOWN_SOURCE_GAP_DAYS]

    if unexpected:
        print(
            f'CONTINUITY WARNING: {len(unexpected)} unexpected missing '
            f'usage day(s) in {start} .. {end}: {", ".join(unexpected)}. '
            f'{len(known)} known source gap(s) excluded. Freshness can still '
            f'be OK while history is missing — a volume rollback, restore, or '
            f'watermark reset looks exactly like this. Check the merge records '
            f'in docs/04_traceability/ before treating it as an ETL fault.'
        )
    else:
        print(
            f'usage continuity OK: no unexpected missing day in '
            f'{start} .. {end}'
            + (f' ({len(known)} known source gap(s) excluded)' if known else '')
        )
    return unexpected


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
    continuity_usage = PythonOperator(
        task_id='check_usage_continuity',
        python_callable=check_usage_continuity,
    )
    volumes = PythonOperator(
        task_id='report_warehouse_volumes',
        python_callable=report_warehouse_volumes,
    )

    # continuity runs first so a warehouse-wide history hole is on the log
    # above the freshness lines, which will still look green in that case.
    chain(continuity_usage, freshness_usage, freshness_temperature, volumes)
