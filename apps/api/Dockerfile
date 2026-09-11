# LaundroTwin — API image.
#
# Strategy (community pattern, pnpm.io/docker Example 1 + turbo prune):
#   prepare : turbo prune --docker -> out/json (deps) + out/full (source) for
#             @laundrytwin/api only (no web/playground/etl in the graph)
#   deps    : full install from pruned tree (build-time, includes devDeps)
#   build   : esbuild bundle -> dist/index.mjs (hono/better-auth/drizzle-orm
#             bundled; better-sqlite3 + dotenv + ai SDK stay external)
#   runtime : node:24-alpine + ONLY the external runtime deps via plain npm
#             (no pnpm workspace hoisting, no devDeps, no store bloat)
#             + dist bundle -> ~60MB image
#
# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t laundrytwin-api .

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

# ---- 1. prune monorepo down to this app ----
FROM base AS prepare
COPY . .
RUN pnpm dlx turbo@2.10.12 prune @laundrytwin/api --docker

# ---- 2. build-time deps (devDeps included, discarded after build) ----
FROM base AS deps
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ---- 3. build the bundle ----
FROM deps AS build
COPY --from=prepare /app/out/full/ .
RUN pnpm --filter @laundrytwin/api build:prod

# ---- 4. minimal alpine runtime: only the external native deps + bundle ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 ships prebuilt musl binaries for alpine (prebuild-install).
# drizzle-kit is a devDependency (db:generate/db:push only) — not needed at runtime.
# ai + @ai-sdk/* + @vercel/oidc stay external (esbuild externals): the SDK's
# transitive CJS (@vercel/oidc) does dynamic require() that breaks when
# inlined into the ESM bundle, so Node resolves it natively at runtime.
# zod stays external too — the SDK validates tool schemas against it at runtime.
RUN npm install --no-save --omit=dev \
      better-sqlite3@12.11.1 \
      dotenv@17.4.2 \
      ai@7.0.97 \
      @ai-sdk/openai-compatible@3.0.47 \
      @vercel/oidc@3.2.0 \
      zod@4.4.3 \
  && npm cache clean --force

COPY --from=build /app/apps/api/dist /app/dist

EXPOSE 8787
CMD ["node", "dist/index.mjs"]