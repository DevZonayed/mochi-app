# ── build ───────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# The scraped skill registry index (served read-only under /registry/*).
COPY registry ./registry
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/index.js"]
