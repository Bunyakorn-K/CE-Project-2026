#!/usr/bin/env bash
# Idempotent Superset bootstrap for the LaundryTwin analytics stack.
#
# Turns an empty superset-home volume into the working "LaundryTwin Analytics"
# dashboard: admin user + ClickHouse connection + seed datasets/dashboards.
# Safe to re-run (admin is create-if-missing, DB upsert, dashboard import is
# UUID-based overwrite).
#
# Usage (on VM 117, from /opt/analytics):
#   sudo CLICKHOUSE_PASSWORD=<pw> SUPERSET_ADMIN_PASSWORD=<pw> ./bootstrap-superset.sh
#
# Env:
#   CLICKHOUSE_PASSWORD   (required) ClickHouse admin password
#   CLICKHOUSE_USER       default admin
#   CLICKHOUSE_HOST       default analytics-clickhouse-1
#   CLICKHOUSE_PORT       default 8123
#   CLICKHOUSE_DATABASE   default laundrytwin_analytics
#   SUPERSET_ADMIN_USER    default admin
#   SUPERSET_ADMIN_EMAIL   default admin@laundrytwin.local
#   SUPERSET_ADMIN_PASSWORD (required if admin does not exist yet)
#   SUPERSET_CONTAINER     default analytics-superset-1
#   SEED_ZIP               default /opt/analytics/seed/laundrytwin-dashboards.zip
set -euo pipefail

CONTAINER="${SUPERSET_CONTAINER:-analytics-superset-1}"
SEED_ZIP="${SEED_ZIP:-/opt/analytics/seed/laundrytwin-dashboards.zip}"
CH_USER="${CLICKHOUSE_USER:-admin}"
CH_PASS="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD is required}"
CH_HOST="${CLICKHOUSE_HOST:-analytics-clickhouse-1}"
CH_PORT="${CLICKHOUSE_PORT:-8123}"
CH_DB="${CLICKHOUSE_DATABASE:-laundrytwin_analytics}"
ADMIN_USER="${SUPERSET_ADMIN_USER:-admin}"
ADMIN_EMAIL="${SUPERSET_ADMIN_EMAIL:-admin@laundrytwin.local}"

log() { echo "[bootstrap] $*"; }

log "0/4 ensure metadata schema (idempotent db upgrade)"
docker exec "$CONTAINER" superset db upgrade 2>/dev/null || docker exec "$CONTAINER" superset db upgrade

log "1/4 ensure admin user (create-if-missing)"
if ! docker exec "$CONTAINER" superset fab create-admin \
    --username "$ADMIN_USER" --firstname LaundryTwin --lastname Admin \
    --email "$ADMIN_EMAIL" --password "${SUPERSET_ADMIN_PASSWORD:?SUPERSET_ADMIN_PASSWORD is required}" 2>/dev/null; then
  log "   admin '$ADMIN_USER' already exists — skipping"
fi

log "1b/4 ensure Admin role can write Database/Dataset/Chart/Dashboard"
# Fresh volumes may have an Admin role without the write permissions the
# dashboard importer needs (superset init can be incomplete during first boot).
docker exec -i -e SUPERSET_ADMIN_USER="$ADMIN_USER" "$CONTAINER" superset shell <<'PY'
import os
from flask import g
from superset.extensions import db, security_manager
g.user = security_manager.find_user(username=os.environ.get('SUPERSET_ADMIN_USER'))
r = security_manager.find_role('Admin')
existing = set(p.id for p in r.permissions)
needed = [security_manager.find_permission_view_menu('can_write', vm) for vm in ('Database', 'Dataset', 'Chart', 'Dashboard')]
r.permissions.extend([pv for pv in needed if pv and pv.id not in existing])
db.session.commit()
print('ensured can_write for Admin on Database/Dataset/Chart/Dashboard')
PY

log "2/4 ensure ClickHouse database connection (upsert)"
docker exec "$CONTAINER" superset set-database-uri \
  -d "$CH_DB" \
  -u "clickhouse://${CH_USER}:${CH_PASS}@${CH_HOST}:${CH_PORT}/${CH_DB}"

log "3/4 import seed dashboards/datasets (UUID upsert)"
docker cp "$SEED_ZIP" "$CONTAINER":/tmp/seed-dashboards.zip
# 1) Inject the real ClickHouse password into the seed zip inside the
#    container (the committed seed carries a __CH_PASSWORD__ placeholder;
#    Superset masks DB passwords on export and import refuses masked ones).
#    docker exec needs -i or stdin is closed and python reads EOF.
# 2) Align the existing ClickHouse DB's uuid (created in step 2) to the seed's
#    database uuid through the ORM — raw SQL would write a text uuid, but
#    Superset stores UUIDs as binary, and the importer (running without
#    can_write on Database in 6.x) reuses an existing uuid instead of creating.
docker exec -i "$CONTAINER" python3 - "$CH_PASS" <<'PY'
import sys, zipfile, shutil
password = sys.argv[1].encode()
src = '/tmp/seed-dashboards.zip'
out = '/tmp/seed-replaced.zip'
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename.endswith('.yaml'):
            data = data.replace(b'__CH_PASSWORD__', password)
        zout.writestr(item, data)
shutil.move(out, src)
print('injected ClickHouse password into seed')
PY
# flask shell is a line-by-line REPL, so every statement is a one-liner.
docker exec -i -e SUPERSET_ADMIN_USER="$ADMIN_USER" "$CONTAINER" superset shell <<'PY'
import os, zipfile, re
from flask import g
from superset.extensions import db, security_manager
from superset.models.core import Database
g.user = security_manager.find_user(username=os.environ.get('SUPERSET_ADMIN_USER'))
seed_uuid = next((re.search(r'uuid:\s*([0-9a-f-]+)', zipfile.ZipFile('/tmp/seed-dashboards.zip').read(n).decode()).group(1) for n in zipfile.ZipFile('/tmp/seed-dashboards.zip').namelist() if '/databases/' in n and n.endswith('.yaml')), None)
assert seed_uuid, 'seed database uuid not found'
print('seed_uuid=' + seed_uuid)
database = db.session.query(Database).filter_by(database_name='laundrytwin_analytics').one()
database.uuid = seed_uuid
db.session.commit()
print('aligned dbs.uuid to seed (' + seed_uuid + ')')
PY
docker exec "$CONTAINER" superset import-dashboards -p /tmp/seed-dashboards.zip -u "$ADMIN_USER"

log "4/4 verify metadata"
docker exec -i "$CONTAINER" python3 - <<'PY'
import sqlite3
con = sqlite3.connect('/app/superset_home/superset.db')
dash = con.execute("SELECT count(*) FROM dashboards WHERE dashboard_title != '[ untitled dashboard ]'").fetchone()[0]
charts = con.execute("SELECT count(*) FROM slices").fetchone()[0]
dsets = con.execute("SELECT count(*) FROM tables WHERE table_name IN ('usage_enriched','temp_enriched')").fetchone()[0]
dbs = con.execute("SELECT count(*) FROM dbs WHERE database_name='laundrytwin_analytics'").fetchone()[0]
print(f"dashboards={dash} charts={charts} virtual_datasets={dsets} clickhouse_db={dbs}")
assert dash >= 1 and charts >= 7 and dsets == 2 and dbs == 1, "bootstrap verification failed"
print("[bootstrap] OK")
PY

log "done — open https://superset.laundrytwin.duckdns.org"
