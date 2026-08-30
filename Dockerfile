FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN corepack enable

# Install every workspace package up front (web/playground/api/etl) so the
# expensive dependency step is shared and cacheable for all later stages.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/playground/package.json apps/playground/package.json
COPY apps/etl/package.json apps/etl/package.json
RUN pnpm install --frozen-lockfile

# Lightweight ETL-only build: no web/playground vite builds, no deploy assets.
# Only apps/etl sources are copied on top of the shared deps layer, so
# rebuilding the ETL image does not pay the web/playground build cost.
FROM deps AS etl-build

WORKDIR /app

COPY apps/etl apps/etl

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY --from=deps /app /app

COPY apps apps
COPY deploy deploy
ARG VITE_LIFF_ID
ENV VITE_LIFF_ID=$VITE_LIFF_ID
RUN pnpm --filter @laundrytwin/web build
RUN pnpm --filter @laundrytwin/playground build

FROM node:22-bookworm-slim AS api

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY --from=build /app /app

EXPOSE 8787
CMD ["pnpm", "--filter", "@laundrytwin/api", "start"]

FROM nginx:1.27-alpine AS web

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

FROM nginx:1.27-alpine AS playground

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/playground/dist /usr/share/nginx/html

EXPOSE 80

FROM node:22-bookworm-slim AS etl

WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable

COPY --from=etl-build /app /app

# ETL runs once and exits; the compose service wraps it in a 5-minute loop
# (see compose.yaml). Provide PG_CONNECTION_STRING / CLICKHOUSE_* via env or
# env-file at runtime. Keep the watermark on a host volume so restarts resume
# from the last committed batch (see /opt/laundrytwin-etl/data on the VM).
CMD ["pnpm", "--filter", "@laundrytwin/etl", "start:container"]
