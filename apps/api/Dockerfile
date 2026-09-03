# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: the native dependencies in this tree ship
# glibc prebuilds and build from source on musl. See DECISIONS.md D7.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
# Manifests first so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json prisma.config.ts ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @machiya/api...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
# `prisma generate` loads prisma.config.ts, which refuses to run without a
# connection string — correctly, since every other command needs one. Generating
# a client does not touch a database, so a placeholder is enough and keeps the
# real error message intact for humans. Nothing at runtime reads this.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
RUN pnpm -F @machiya/shared build \
  && pnpm -F @machiya/db build \
  && pnpm -F @machiya/api build
# Collapse the workspace into a self-contained prod tree.
RUN pnpm --filter @machiya/api deploy --legacy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
