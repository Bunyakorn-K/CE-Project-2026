FROM apache/superset:6.1.0

# ClickHouse connectivity for the laundrytwin_analytics dataset.
# clickhouse-sqlalchemy 0.3.x requires SQLAlchemy 2.x which conflicts with this
# Superset build (ships 1.4.x); 0.2.x registers the dialect as clickhouse://
# (HTTP transport on 8123) and works with 1.4. sqlalchemy pinned so uv cannot
# silently upgrade it while resolving the clickhouse packages.
#
# Background: the drivers were originally pip-installed by hand inside the
# running container, so every docker compose up -d (container recreate) silently
# wiped them and every dashboard chart died with
# "Can't load plugin: sqlalchemy.dialects:clickhousedb". Baking them into a
# derived image makes the recreate-safe path the default.
USER root
RUN uv pip install --no-cache-dir \
    sqlalchemy==1.4.54 \
    clickhouse-sqlalchemy==0.2.4 \
    clickhouse-driver==0.2.6
USER superset
