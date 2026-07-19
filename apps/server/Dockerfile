# Build from the repository root:
#   docker build -f apps/server/Dockerfile .
#
# Dokploy values:
#   dockerContextPath = .
#   dockerfile        = apps/server/Dockerfile

# ── deps ────────────────────────────────────────────────────────────
FROM node:24-slim AS deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/realtime/package.json packages/realtime/package.json
RUN pnpm install --frozen-lockfile --filter @maestro/server...

# ── build ───────────────────────────────────────────────────────────
FROM deps AS build
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
COPY packages/realtime packages/realtime
RUN pnpm --filter @maestro/server build

# ── runtime ─────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/realtime/package.json packages/realtime/package.json
RUN pnpm install --frozen-lockfile --prod --filter @maestro/server...
COPY --from=build /app/apps/server/dist apps/server/dist
COPY packages/realtime packages/realtime
COPY apps/server/registry apps/server/registry
WORKDIR /app/apps/server
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "--import", "tsx", "dist/index.js"]
