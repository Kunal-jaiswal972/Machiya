# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @machiya/web...
COPY packages/shared packages/shared
COPY apps/web apps/web

# Vite inlines these at build time, so they are build args, not runtime env.
ARG VITE_API_BASE_URL=http://localhost:4000
ARG VITE_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty
ARG VITE_DEFAULT_CITY=patna
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_MAP_STYLE_URL=$VITE_MAP_STYLE_URL
ENV VITE_DEFAULT_CITY=$VITE_DEFAULT_CITY

RUN pnpm -F @machiya/shared build && pnpm -F @machiya/web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -q --spider http://127.0.0.1/healthz || exit 1
