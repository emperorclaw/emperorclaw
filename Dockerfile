# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

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
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build output (Next.js output: "standalone")
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy migrations for startup
COPY --from=builder /app/src/db/migrations ./src/db/migrations
COPY --from=builder /app/drizzle.config.ts ./

# Storage directory for local backend
RUN mkdir -p .data/storage && chown -R nextjs:nodejs .data

USER nextjs

EXPOSE 3000

# Run migrations then start server
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && node server.js"]
