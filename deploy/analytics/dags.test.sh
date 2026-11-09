#!/usr/bin/env bash
# DAG unit tests — local harness, no Airflow, no Python test runner.
#
# Airflow cannot be imported in this repository (it exists only in the
# `apache/airflow` containers), so the DAGs are exercised against stub modules:
# `airflow`, `pendulum` and `sqlalchemy` are replaced in `sys.modules` before the
# DAG files are loaded. That is enough to assert the two things a DAG can get
# wrong without a cluster:
#
#   1. `check_postgres_reinit` warns with BOTH timestamps when the postmaster
#      start time moves, initialises on its first run, and stays quiet when the
#      value is unchanged.
#   2. `sweep_alerts` FAILS (rather than silently succeeding) when the token
#      Variable is missing, when the endpoint answers non-200, and when the body
#      is not JSON — prints the summary verbatim on success, and WARNS (without
#      failing) when the answer is a 200 whose IRIS half could not be read.
#
# Run: bash deploy/analytics/dags.test.sh
# Exit 0 = all pass. Exit 1 = at least one failed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 - "$SCRIPT_DIR/dags" <<'PY'
import contextlib
import importlib.util
import io
import json
import os
import sys
import types
import urllib.error

DAGS_DIR = sys.argv[1]
PASS = 0
FAIL = 0


def check(name, condition, detail=""):
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"ok   {name}")
    else:
        FAIL += 1
        print(f"FAIL {name}{(': ' + detail) if detail else ''}")


# --- stub modules ---------------------------------------------------------

def module(name, **attrs):
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


class AirflowFailException(Exception):
    pass


class FakeDAG:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOperator:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class Variable:
    store = {}

    @classmethod
    def get(cls, key, default_var=None):
        return cls.store.get(key, default_var)

    @classmethod
    def set(cls, key, value):
        cls.store[key] = value


module("pendulum", datetime=lambda *a, **k: None)
module("airflow", DAG=FakeDAG)
module("airflow.models", Variable=Variable)
module("airflow.sdk")
module("airflow.sdk.exceptions", AirflowFailException=AirflowFailException)
module("airflow.sdk.bases")
module("airflow.sdk.bases.operator", chain=lambda *tasks: list(tasks))
module("airflow.providers")
module("airflow.providers.standard")
module("airflow.providers.standard.operators")
module("airflow.providers.standard.operators.python", PythonOperator=FakeOperator)

FAKE_START = {"value": "2026-11-06 14:52:01.576626+00:00"}
FAKE_SQL_STATE = {"raise": None}


class _Cursor:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, statement):
        if FAKE_SQL_STATE["raise"]:
            raise FAKE_SQL_STATE["raise"]

    def fetchone(self):
        return (FAKE_START["value"],)


class _Conn:
    def cursor(self):
        return _Cursor()

    def close(self):
        pass


class _PostgresHook:
    """Stands in for Airflow's PostgresHook: no DSN, no credential, no network."""

    def __init__(self, postgres_conn_id=None):
        self.postgres_conn_id = postgres_conn_id

    def get_conn(self):
        if FAKE_SQL_STATE["raise"]:
            raise FAKE_SQL_STATE["raise"]
        return _Conn()


module("airflow.providers.postgres")
module("airflow.providers.postgres.hooks")
module("airflow.providers.postgres.hooks.postgres", PostgresHook=_PostgresHook)


def load(name):
    path = os.path.join(DAGS_DIR, name)
    spec = importlib.util.spec_from_file_location(name.replace(".py", ""), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


freshness = load("laundrytwin_warehouse_freshness.py")
sweep_dag = load("laundrytwin_alert_sweep.py")

check("freshness DAG loads and declares check_postgres_reinit", hasattr(freshness, "check_postgres_reinit"))
check("alert sweep DAG loads and declares sweep_alerts", hasattr(sweep_dag, "sweep_alerts"))

# --- check_postgres_reinit ------------------------------------------------

Variable.store.clear()
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    first = freshness.check_postgres_reinit()
check("first run initialises the Variable", "initialised" in buffer.getvalue(), buffer.getvalue())
check("first run stores the start time", Variable.store.get("postgres_postmaster_start_time") == FAKE_START["value"])

buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    second = freshness.check_postgres_reinit()
check("unchanged start time reports OK", "unchanged" in buffer.getvalue(), buffer.getvalue())
check("unchanged start time raises no warning", "WARNING" not in buffer.getvalue())

FAKE_START["value"] = "2026-11-09 04:06:26.100000+00:00"
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    third = freshness.check_postgres_reinit()
output = buffer.getvalue()
check("a moved start time warns", "POSTGRES REINIT WARNING" in output, output)
check("the warning names the previous start", "2026-11-06 14:52:01.576626+00:00" in output, output)
check("the warning names the current start", "2026-11-09 04:06:26.100000+00:00" in output, output)
check("the Variable follows the new start", Variable.store.get("postgres_postmaster_start_time") == FAKE_START["value"])

FAKE_SQL_STATE["raise"] = RuntimeError("connection refused")
try:
    freshness.check_postgres_reinit()
    check("a database failure propagates rather than reporting a healthy cluster", False)
except RuntimeError:
    check("a database failure propagates rather than reporting a healthy cluster", True)
finally:
    FAKE_SQL_STATE["raise"] = None

# --- sweep_alerts ---------------------------------------------------------

Variable.store.clear()


def fail_with(exc):
    def urlopen(request, timeout=None):
        raise exc
    return urlopen


try:
    with contextlib.redirect_stdout(io.StringIO()):
        sweep_dag.sweep_alerts()
    check("a missing token Variable fails", False)
except AirflowFailException as error:
    check("a missing token Variable fails", "alert_sweep_token" in str(error), str(error))

Variable.store["alert_sweep_token"] = "not-printed"

original_urlopen = sweep_dag.urllib.request.urlopen

sweep_dag.urllib.request.urlopen = fail_with(
    urllib.error.HTTPError("http://app:8787/x", 401, "Unauthorized", {}, io.BytesIO(b'{"error":{"code":"UNAUTHORIZED"}}'))
)
try:
    with contextlib.redirect_stdout(io.StringIO()):
        sweep_dag.sweep_alerts()
    check("a 401 fails the task", False)
except AirflowFailException as error:
    check("a 401 fails the task", "401" in str(error), str(error))
    check("the failure message explains the token", "ALERT_SWEEP_TOKEN" in str(error), str(error))

sweep_dag.urllib.request.urlopen = fail_with(urllib.error.URLError("name resolution failed"))
try:
    with contextlib.redirect_stdout(io.StringIO()):
        sweep_dag.sweep_alerts()
    check("an unreachable endpoint fails the task", False)
except AirflowFailException as error:
    check("an unreachable endpoint fails the task", "unreachable" in str(error), str(error))


class _Response:
    status = 200

    def __init__(self, body):
        self._body = body.encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


sweep_dag.urllib.request.urlopen = lambda request, timeout=None: _Response(
    json.dumps({"scanned": 0, "window": {"from": "a", "to": "b"}, "summary": {"scanned": 0}, "gas": {"evaluated": 3}})
)
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    result = sweep_dag.sweep_alerts()
check("a 200 prints the summary verbatim", "alert sweep summary: " in buffer.getvalue(), buffer.getvalue())
check("a 0-alert sweep is a valid pass carrying scanned: 0", result.get("scanned") == 0)
check("the printed summary carries the gas evaluation count", '"evaluated": 3' in buffer.getvalue(), buffer.getvalue())

# A 200 with an unread IRIS list is a real measurement of the gas rules and a
# stated gap for everything else. It must PASS — failing it would make the gas
# rules unrunnable on a host where they work — and it must say so in the log,
# because `scanned: 0` on its own reads as "no alerts were found".
sweep_dag.urllib.request.urlopen = lambda request, timeout=None: _Response(
    json.dumps(
        {
            "scanned": 0,
            "window": {"from": "a", "to": "b"},
            "summary": {"scanned": 0},
            "iris": {"state": "unavailable", "reason": "reporting_source_unavailable"},
            "gas": {"state": "evaluated", "evaluated": 3},
        }
    )
)
buffer = io.StringIO()
with contextlib.redirect_stdout(buffer):
    sweep_dag.sweep_alerts()
check(
    "a 200 with an unread IRIS list passes and warns",
    "the IRIS alert list was not read" in buffer.getvalue(),
    buffer.getvalue(),
)

sweep_dag.urllib.request.urlopen = lambda request, timeout=None: _Response("not json")
try:
    with contextlib.redirect_stdout(io.StringIO()):
        sweep_dag.sweep_alerts()
    check("a non-JSON body fails rather than passing silently", False)
except AirflowFailException as error:
    check("a non-JSON body fails rather than passing silently", "non-JSON" in str(error), str(error))

sweep_dag.urllib.request.urlopen = original_urlopen

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
PY
