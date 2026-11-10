# Airflow DAG: LaundryTwin daily digest
#
# WHY THIS IS NOT A CRON AT 07:00. The hour is an owner's setting in the console, and
# it changes. A DAG pinned to 07:00 would keep sending at 07:00 no matter what the
# console says, and "change the hour" would become a workflow edit plus a deploy. So
# this wakes up every five minutes and asks the app whether it is time; the app
# compares the clock against the stored hour, in the shop's timezone, and answers
# `not-yet` (a pass) until it is.
#
# WHY IT CAN RUN EVERY FIVE MINUTES SAFELY. `digest_sent` records one row per
# recipient per day, written only after a successful send, so overlapping runs and
# retries cannot produce a second message. A `failed` row does not close the day: the
# next run tries again, which is the whole point of retrying.
#
# OFF MEANS OFF. With no settings row the app answers `state: disabled` and this DAG
# prints that and passes. Same for `no-recipients`. Neither is a failure — they are
# the default state of a feature an owner has not turned on.
#
# A SEND THAT DID NOT HAPPEN IS A FAILURE. `summary.failed > 0` raises, so a broken
# LINE token or an unreachable API shows red instead of quietly skipping the day.
#
# SECRETS. The token is the same Airflow Variable `alert_sweep_token` the sweep DAG
# uses, because it is the same machine credential (`ALERT_SWEEP_TOKEN`) and one
# variable is one place to rotate. It is never printed or written to a file.

import json
import urllib.error
import urllib.request
from datetime import timedelta

from pendulum import datetime as pendulum_datetime

from airflow import DAG
from airflow.sdk.exceptions import AirflowFailException
from airflow.providers.standard.operators.python import PythonOperator

DEFAULT_DIGEST_URL = 'http://app:8787/api/internal/digest/run'
DIGEST_TIMEOUT_SECONDS = 180

default_args = {
    'owner': 'analytics',
    'retries': 2,
    'retry_delay': timedelta(minutes=5),
    'execution_timeout': timedelta(minutes=10),
}


def run_digest(**context):
    """POST the digest endpoint once and print its summary verbatim."""
    from airflow.models import Variable

    url = Variable.get('digest_url', default_var=DEFAULT_DIGEST_URL)
    token = Variable.get('alert_sweep_token', default_var=None)
    if not token:
        raise AirflowFailException(
            'Airflow Variable alert_sweep_token is not set: the digest endpoint '
            'requires the same machine token as the alert sweep. Set it to the '
            'value of ALERT_SWEEP_TOKEN in the app environment.'
        )

    request = urllib.request.Request(
        url,
        method='POST',
        headers={'x-alert-sweep-token': token, 'accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(request, timeout=DIGEST_TIMEOUT_SECONDS) as response:
            status = response.status
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors='replace')[:500]
        raise AirflowFailException(f'digest answered HTTP {error.code} at {url}: {detail}') from error
    except urllib.error.URLError as error:
        raise AirflowFailException(
            f'digest endpoint unreachable at {url}: {error.reason}. The scheduler must '
            'share a network with the app container (deploy/analytics/compose.yaml '
            'attaches it to laundrytwin_default, where the app alias is `app`).'
        ) from error

    if status != 200:
        raise AirflowFailException(f'digest answered HTTP {status} at {url}: {body[:500]}')

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise AirflowFailException(f'digest returned a non-JSON body at {url}: {body[:500]}') from error

    summary = payload.get('digest') or {}
    print('digest summary: ' + json.dumps(summary, ensure_ascii=False, sort_keys=True))

    if summary.get('failed', 0) > 0:
        raise AirflowFailException(
            f"digest failed for {summary['failed']} recipient(s) on {summary.get('day')}: "
            'see digest_sent.status = failed for the provider error. The day stays open, '
            'so the next run will try again.'
        )

    state = summary.get('state')
    if state == 'disabled':
        print('digest is turned off in the console — nothing sent.')
    elif state == 'not-yet':
        print(f"digest is not due yet for {summary.get('day')} — the console sets the hour.")
    elif state == 'no-recipients':
        print('digest is on but nobody has been added as a recipient — nothing sent.')
    return summary


with DAG(
    dag_id='laundrytwin_daily_digest',
    default_args=default_args,
    description='Ask the LaundryTwin app whether the daily digest is due, and send it (P4)',
    schedule='*/5 * * * *',
    start_date=pendulum_datetime(2026, 11, 10),
    catchup=False,
    max_active_runs=1,
    tags=['analytics', 'digest', 'line', 'p4'],
) as dag:
    digest = PythonOperator(
        task_id='run_digest',
        python_callable=run_digest,
    )
