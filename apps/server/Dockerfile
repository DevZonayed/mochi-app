# ── build ───────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
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
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# The scraped skill registry index (served read-only under /registry/*).
COPY registry ./registry
EXPOSE 8080
CMD ["node", "dist/index.js"]
