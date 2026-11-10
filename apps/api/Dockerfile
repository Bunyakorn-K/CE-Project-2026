# LaundryTwin — the application image: API + SPA in one container.
#
# These were two images (laundrytwin-api on node, laundrytwin-web on nginx) and
# two independent tags, but they were never independent in fact: the runbook
# already records deploying them as a pair, because the web reads fields the API
# change introduces. Two tags with two independent rollout inputs described a
# coupling the release process did not have, and a `web`-only rollout of a build
# whose API contract changed was the failure waiting behind it. One image makes
# the constraint structural.
#
# nginx is gone rather than kept as a sidecar. What deploy/nginx.conf did was
# serve static files, proxy /api/, and fall back to index.html — all of which
# apps/api/src/spa.ts does in the same process, with the added property that the
# fallback refuses server paths (see decideSpaResponse).
#
# Strategy (pnpm.io/docker Example 1 + turbo prune):
#   prepare : turbo prune --docker for BOTH apps at once. The scope list is
#             variadic, so one prune carries the pair and they cannot drift into
#             different dependency graphs.
#   deps    : full install from the pruned tree (build-time, includes devDeps)
#   build   : vite build -> apps/web/dist, esbuild -> apps/api/dist/index.mjs
#   runtime : node:24-alpine + ONLY the API's external runtime deps via plain
#             npm, plus both dist trees
#
# Build from the repo root:
#   docker build -f apps/api/Dockerfile -t laundrytwin .

# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

# ---- 1. prune the monorepo down to the two apps this image serves ----
FROM base AS prepare
COPY . .
RUN pnpm dlx turbo@2.10.12 prune @laundrytwin/api @laundrytwin/web --docker

# ---- 2. build-time deps (devDeps included, discarded after build) ----
FROM base AS deps
COPY --from=prepare /app/out/json/ .
RUN pnpm install --frozen-lockfile

# ---- 3. build both halves ----
FROM deps AS build
# Baked into the bundle at build time, not read from the browser at runtime.
ARG VITE_LIFF_ID
ENV VITE_LIFF_ID=$VITE_LIFF_ID
COPY --from=prepare /app/out/full/ .
RUN pnpm --filter @laundrytwin/web build
RUN pnpm --filter @laundrytwin/api build:prod

# ---- 4. minimal alpine runtime: external native deps + both bundles ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
# Where spa.ts looks for the built SPA. Absent in a bare API run (the ETL image,
# tests), where the handler is not mounted at all.
ENV WEB_ROOT=/app/public
WORKDIR /app

# better-sqlite3 ships prebuilt musl binaries for alpine (prebuild-install).
# drizzle-kit is a devDependency (db:generate/db:push only) — not needed at runtime.
# ai + @ai-sdk/* + @vercel/oidc stay external (esbuild externals): the SDK's
# transitive CJS (@vercel/oidc) does dynamic require() that breaks when
# inlined into the ESM bundle, so Node resolves it natively at runtime.
# zod stays external too — the SDK validates tool schemas against it at runtime.
# These versions are the LOCKFILE's, copied by hand because the runtime stage has
# no package manager to read it. That is a Dependabot blind spot: the scanner reads
# pnpm-lock.yaml, so a vulnerable version pinned only here ships silently — which is
# what zod@4.4.3 was doing (memory exhaustion while validating oversized constrained
# collections, patched in 4.6.6). Keep them equal to the resolved versions, and let
# runtime-deps.test.ts fail the build when a pin falls below a patched floor.
RUN npm install --no-save --omit=dev \
      better-sqlite3@12.11.1 \
      dotenv@17.4.2 \
      ai@7.0.97 \
      @ai-sdk/openai-compatible@3.0.47 \
      @vercel/oidc@3.2.0 \
      zod@4.6.7 \
  && npm cache clean --force

# Fail the build rather than ship a tree someone cannot audit: the pinned versions
# above are the whole runtime dependency set, so this is a complete check.
RUN node -e "const r=p=>require('/app/node_modules/'+p+'/package.json').version,v=s=>s.split('.').map(Number),lt=(a,b)=>{const A=v(a),B=v(b);for(let i=0;i<3;i++){if(A[i]!==B[i])return A[i]<B[i]}return false};const floors={zod:'4.6.6'};let bad=false;for(const[p,min]of Object.entries(floors)){const got=r(p);if(lt(got,min)){console.error(p+'@'+got+' is below the patched '+min);bad=true}}if(bad)process.exit(1)"

COPY --from=build /app/apps/api/dist /app/dist
COPY --from=build /app/apps/web/dist /app/public

# The rich menu images, rendered by deploy/line/render-rich-menus.py and committed.
# They are uploaded to LINE by POST /api/admin/rich-menus/sync, which runs in this
# container — so the PNGs have to be here, not only in the repository.
COPY deploy/line/rich-menus /app/rich-menus

EXPOSE 8787
CMD ["node", "dist/index.mjs"]
