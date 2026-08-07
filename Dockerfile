FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY deploy deploy
ARG VITE_LIFF_ID
ENV VITE_LIFF_ID=$VITE_LIFF_ID
RUN pnpm --filter @laundrytwin/web build

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
