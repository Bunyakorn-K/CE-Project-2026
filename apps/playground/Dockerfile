# LaundroTwin — Playground image (static, legacy demo surface).
#
# Per-app Dockerfile using turbo prune --docker; runtime = nginx + static dist.
#
# Build from the repo root:
#   docker build -f apps/playground/Dockerfile -t laundrytwin-playground .

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS prepare
COPY . .
RUN pnpm dlx turbo@2.10.12 prune @laundrytwin/playground --docker

FROM base AS deps
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_LIFF_ID
ENV VITE_LIFF_ID=$VITE_LIFF_ID
COPY --from=prepare /app/out/full/ .
RUN pnpm --filter @laundrytwin/playground build

FROM nginx:1.30-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/playground/dist /usr/share/nginx/html
EXPOSE 80