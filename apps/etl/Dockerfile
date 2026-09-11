# LaundroTwin — ETL worker + Weather collector images.
#
# Strategy: turbo prune (etl only) + plain npm runtime deps on alpine
# (tsx, pg, date-fns, date-fns-tz) — no pnpm workspace hoisting in the
# runtime image. etl executes TS sources directly through tsx.
#
# Targets:
#   etl      (default) — ingestion worker:   node --import tsx src/index.ts
#   weather             — TMD weather poller: node --import tsx src/weather-run.ts
#
# Build from the repo root:
#   docker build -f apps/etl/Dockerfile -t laundrytwin-etl .
#   docker build -f apps/etl/Dockerfile --target weather -t laundrytwin-weather .

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

# ---- 1. prune monorepo down to this app ----
FROM base AS prepare
COPY . .
RUN pnpm dlx turbo@2.10.12 prune @laundrytwin/etl --docker

# ---- 2. minimal alpine runtime: only the runtime deps (prod, plain npm) ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN npm install --no-save --omit=dev \
      tsx@4.23.1 \
      pg@8.23.0 \
      date-fns@4.4.0 \
      date-fns-tz@3.2.0 \
  && npm cache clean --force

COPY --from=prepare /app/out/full/apps/etl /app/apps/etl
WORKDIR /app/apps/etl
CMD ["sh", "-c", "while true; do node --import tsx src/index.ts; sleep 300; done"]

FROM runtime AS weather
CMD ["sh", "-c", "while true; do node --import tsx src/weather-run.ts; sleep 300; done"]