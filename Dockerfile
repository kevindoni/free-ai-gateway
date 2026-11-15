# syntax=docker/dockerfile:1
#
# Base image: node:24-alpine (NOT node:22-alpine).
# Rationale: src/database.ts imports `node:sqlite` (DatabaseSync).
#   - Node 22.5–23: experimental, requires `--experimental-sqlite` flag
#     (fallback CMD below if you ever switch back to node:22-alpine).
#   - Node 24+: stable, no flag needed.

########## Stage 1 — build (TypeScript -> dist/) ##########
FROM node:24-alpine AS build

WORKDIR /app

# package-lock.json may not exist yet -> wildcard copy, npm ci with fallback
COPY package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

RUN npx tsc

########## Stage 2 — runtime ##########
FROM node:24-alpine

ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    GATEWAY_HOST=0.0.0.0

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist

# Extra provider modules, if present (folder is currently empty in-repo)
COPY providers* ./providers/

# Non-root: "node" user ships with the official image. Pre-create the data
# dir so a freshly mounted named volume inherits node ownership.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8080
VOLUME ["/app/data"]

# node:sqlite is stable on Node 24 -> plain CMD.
# Fallback for node:22-alpine base images:
#   CMD ["node", "--experimental-sqlite", "dist/index.js"]
CMD ["node", "dist/index.js"]
