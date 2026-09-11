# LaundroTwin — Web image (static frontend).
#
# Per-app Dockerfile using turbo prune --docker:
#   build   : vite build (from full pruned tree) -> apps/web/dist
#   runtime : nginx:alpine + static dist only (~30MB)
#
# Build from the repo root:
#   docker build -f apps/web/Dockerfile -t laundrytwin-web .

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS prepare
COPY . .
RUN pnpm dlx turbo@2.10.12 prune @laundrytwin/web --docker

FROM base AS deps
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG VITE_LIFF_ID
ENV VITE_LIFF_ID=$VITE_LIFF_ID
COPY --from=prepare /app/out/full/ .
RUN pnpm --filter @laundrytwin/web build

FROM nginx:1.30-alpine AS runtime
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80