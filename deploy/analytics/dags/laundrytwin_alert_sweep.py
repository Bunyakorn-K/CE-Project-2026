# Airflow DAG: LaundryTwin alert sweep (R05)
#
# WHY THIS EXISTS. The alert engine (`apps/api/src/alert-engine.ts`) is
# idempotent per (alert, recipient), cools down per alert class, claims rows
# before sending and audits the skips — all correct, and until 2026-11-09
# nothing ran it except an owner pressing a button. R05 is "event-driven
# notifications with cooldowns"; an engine that fires when somebody remembers is
# not that.
#
# HOW IT REACHES THE APP. The app lives on `laundrytwin_default`, where its
# alias is `app` — NOT on `analytics_default`. The first version of this comment
# claimed otherwise and the DAG would have failed DNS every 5 minutes, so the
# scheduler is attached to both networks in `deploy/analytics/compose.yaml`
# (`networks: [default, laundrytwin]`, external name `laundrytwin_default`).
# Measured 2026-11-09 from inside `analytics-airflow-scheduler-1`:
# `getent hosts app` → 172.18.0.2 and `http://app:8787/health` → 200. Nothing new
# is published to the host for this.
#
# WHAT MAKES IT SAFE TO RUN EVERY 5 MINUTES. Everything the endpoint invokes is
# idempotent, so a retry, an overlapping manual press and this schedule can
# coexist: a second sweep inside the cooldown window sends nothing and reports
# `cooldown > 0`. `max_active_runs=1` stops this DAG overlapping itself.
#
# A FAIL, NOT A SWALLOWED ERROR. A sweep that 401s (wrong or missing token) is
# the same class of defect as a monitoring check that exists but does not run:
# it would look green forever while nothing was notified. Any non-200 answer
# fails the task, and the response body is included in the message so the log
# names the reason.
#
# THE ONE 200 THAT IS STILL A GAP. Production configures no IRIS read endpoint,
# so the endpoint answers 200 with `iris: {state: "unavailable"}` and evaluates
# only the gas rules — a real measurement of one source, and a stated gap for the
# other. That case prints WARNING instead of failing, because failing it would
# make the gas rules unrunnable on a host where they work; the warning is in
# every log until IRIS exists, and `scanned: 0` beside it must never be read as
# "no alerts were found".
#
# SECRETS. The token lives in the Airflow Variable `alert_sweep_token` and is
# never printed, logged, or written to a file. Records quote the variable name.

import json
import urllib.error
import urllib.request
from datetime import timedelta

from pendulum import datetime as pendulum_datetime

from airflow import DAG
from airflow.sdk.exceptions import AirflowFailException
from airflow.providers.standard.operators.python import PythonOperator

DEFAULT_SWEEP_URL = 'http://app:8787/api/internal/alerts/sweep'
SWEEP_TIMEOUT_SECONDS = 120

default_args = {
    'owner': 'analytics',
    'retries': 2,
    'retry_delay': timedelta(minutes=2),
    'execution_timeout': timedelta(minutes=5),
}


def sweep_alerts(**context):
    """POST the sweep endpoint once and print its summary verbatim.

    The summary is printed as received (it carries the window, the IRIS counts
    and the gas evaluation), because an evidence record quotes this line
    unchanged. A `0 alerts` result is a valid pass and reads `scanned: 0`.
    """
    from airflow.models import Variable

    url = Variable.get('alert_sweep_url', default_var=DEFAULT_SWEEP_URL)
    token = Variable.get('alert_sweep_token', default_var=None)
    if not token:
        raise AirflowFailException(
            'Airflow Variable alert_sweep_token is not set: the sweep endpoint '
            'requires a machine token and would answer 401. Set the Variable to '
            'the same value as ALERT_SWEEP_TOKEN in the app environment.'
        )

    request = urllib.request.Request(
        url,
        method='POST',
        headers={'x-alert-sweep-token': token, 'accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=SWEEP_TIMEOUT_SECONDS) as response:
            status = response.status
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        raise AirflowFailException(
            f'alert sweep answered HTTP {error.code} at {url}: {detail}. '
            'A 401 means the token does not match ALERT_SWEEP_TOKEN.'
        ) from error
    except urllib.error.URLError as error:
        raise AirflowFailException(
            f'alert sweep endpoint unreachable at {url}: {error.reason}. '
            'The scheduler must share a network with the app container '
            '(deploy/analytics/compose.yaml attaches it to laundrytwin_default, '
            'where the app alias is `app`); a container being recreated also '
            'resolves to nothing for a few seconds.'
        ) from error

    if status != 200:
        raise AirflowFailException(f'alert sweep answered HTTP {status} at {url}: {body[:500]}')

    try:
        summary = json.loads(body)
    except json.JSONDecodeError as error:
        raise AirflowFailException(f'alert sweep returned a non-JSON body at {url}: {body[:500]}') from error

    print('alert sweep summary: ' + json.dumps(summary, ensure_ascii=False, sort_keys=True))

    iris = summary.get('iris') or {}
    if iris.get('state') != 'evaluated':
        print(
            'WARNING: the IRIS alert list was not read (state={state}, reason={reason}); '
            'only the gas rules were evaluated, so `scanned` is a gap and not a zero.'.format(
                state=iris.get('state'), reason=iris.get('reason')
            )
        )
    gas = summary.get('gas') or {}
    if gas.get('state') != 'evaluated':
        print(
            'WARNING: the gas source was not evaluated (state={state}, reason={reason}).'.format(
                state=gas.get('state'), reason=gas.get('reason')
            )
        )
    return summary


with DAG(
    dag_id='laundrytwin_alert_sweep',
    default_args=default_args,
    description='Trigger the LaundryTwin IRIS + gas alert sweep every 5 minutes (R05)',
    schedule='*/5 * * * *',
    start_date=pendulum_datetime(2026, 11, 9),
    catchup=False,
    max_active_runs=1,
    tags=['analytics', 'alerts', 'line', 'r05'],
) as dag:
    sweep = PythonOperator(
        task_id='sweep_alerts',
        python_callable=sweep_alerts,
    )
