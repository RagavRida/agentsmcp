# syntax=docker/dockerfile:1.6

# ----- build stage: compile TS, install full deps -----
FROM node:20-alpine AS build
WORKDIR /app

# Install build dependencies for better-sqlite3's native module.
RUN apk add --no-cache python3 make g++ libc6-compat

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src
RUN npx tsc

# Prune to production dependencies for the runtime stage.
RUN npm prune --omit=dev


# ----- runtime stage: tiny image, no build tools -----
FROM node:20-alpine AS runtime
WORKDIR /app

# better-sqlite3 needs the C runtime; alpine ships musl, but the
# precompiled binary wants glibc-compat in some cases.
RUN apk add --no-cache libc6-compat

# Non-root user for the server process.
RUN addgroup -S agentsmcp && adduser -S agentsmcp -G agentsmcp

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY LICENSE README.md ./

# App Runner hits port 8080 by default; honour PORT if explicitly set.
ENV PORT=8080
# In-memory SQLite by default — appropriate for the public demo since
# data is wiped on every container restart. Override with AGENTSMCP_DB
# pointing at a mounted volume for persistent deployments.
ENV AGENTSMCP_DB=:memory:

USER agentsmcp
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "dist/server.js"]
