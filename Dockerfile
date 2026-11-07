# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# The version this image will report. Docker Publish passes the git tag here
# (v0.31.1), so /api/health, /api/version and the update banner state the tag
# that was actually released instead of relying on someone bumping
# package.json before tagging — the drift that made v0.31.1 report 0.31.0.
# Declared in both stages: the builder needs it if Next ever inlines it, the
# runner needs it at request time.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- Production Stage ----
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Release tag this image was built from (see builder stage). Read at runtime by
# src/lib/app-version.ts; empty on a local `docker build`, which falls back to
# the package.json version.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
ENV PORT=3000
# Bind to all interfaces. Next's standalone server defaults to $HOSTNAME, which
# Docker sets to the container ID — so it would listen only on the container's
# eth0 IP and not loopback, breaking in-container healthchecks (wget localhost).
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output (Next.js output: "standalone"). npm run build also
# bundles server.ts into it as emperor-server.js (scripts/build-server.mjs).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy migrations for startup
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY --from=builder /app/src/db/migrate.ts ./src/db/migrate.ts
COPY --from=builder /app/src/db/index.ts ./src/db/index.ts
COPY --from=builder /app/src/db/pg-utc.ts ./src/db/pg-utc.ts
COPY --from=builder /app/src/db/schema.ts ./src/db/schema.ts
# src/db/migrate.ts imports ../lib/character/migrate-avatars, which imports the
# `@/db` alias — so the character module and tsconfig.json (tsx path resolution)
# must be present in the runner image for migrations to run at startup.
COPY --from=builder /app/src/lib/character ./src/lib/character
# migrate.ts also backfills knowledge summaries at startup (see tests/dockerfile-migrate-imports.test.cjs).
COPY --from=builder /app/src/lib/knowledge-backfill.ts ./src/lib/knowledge-backfill.ts
COPY --from=builder /app/src/lib/knowledge-summary.ts ./src/lib/knowledge-summary.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/scripts/reconcile-artifact-storage.ts ./scripts/reconcile-artifact-storage.ts
COPY --from=builder /app/drizzle.config.ts ./
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv
COPY --from=builder /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder /app/node_modules/pg ./node_modules/pg

# Install tsx for running TypeScript migrations
RUN npm install -g tsx

# Storage directory for local backend
RUN mkdir -p .data/storage && chown -R nextjs:nodejs .data

USER nextjs

EXPOSE 3000

# Run migrations, then start the custom server (server.ts bundled as
# emperor-server.js): Next in production mode plus the agent (/api/mcp/ws) and
# browser (/api/ws) WebSockets and the Postgres LISTEN fan-out. Next's stock
# standalone server.js is still in the image but serves no WebSockets.
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && node emperor-server.js"]
