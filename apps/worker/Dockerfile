# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json prisma.config.ts ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @machiya/worker...
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/worker apps/worker
# `prisma generate` loads prisma.config.ts, which refuses to run without a
# connection string — correctly, since every other command needs one. Generating
# a client does not touch a database, so a placeholder is enough and keeps the
# real error message intact for humans. Nothing at runtime reads this.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build?schema=public
RUN pnpm -F @machiya/shared build \
  && pnpm -F @machiya/db build \
  && pnpm -F @machiya/worker build
RUN pnpm --filter @machiya/worker deploy --legacy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WORKER_PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
