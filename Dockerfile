# syntax=docker/dockerfile:1
#
# AI Daily News Digest — production image (Render Web Service, Docker runtime).
# One container: Fastify API + pg-boss workers + the built React app.
# No .env, keys, or secrets are copied in; all configuration comes from the
# platform's environment variables at runtime (see docs/deployment.md).

# Node 22 LTS (matches .mise.toml); pnpm is pinned to package.json's packageManager.
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.34.3

# ---------------------------------------------------------------------------
# 1. Build: install all workspace dependencies and compile every package.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV CI=true
WORKDIR /app
# Installed via npm: older bundled corepack versions fail npm's rotated signing keys.
RUN npm install -g pnpm@${PNPM_VERSION}

# Manifests first so the dependency layer is cached between source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
# vite.config.ts imports the Figma Make site config (used only by dev-mode plugins).
COPY .figma/make/site.json .figma/make/site.json
# Same as the root "build" script, without going through corepack.
RUN pnpm --recursive --workspace-concurrency=1 --if-present build \
 && find apps/server/dist -name "*.test.js" -delete

# ---------------------------------------------------------------------------
# 2. Production dependencies only (server + its workspace packages).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
ARG PNPM_VERSION
ENV CI=true
WORKDIR /app
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --prod --filter "@aidnd/server..."

# ---------------------------------------------------------------------------
# 3. Runtime: compiled output + production node_modules, non-root.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=prod-deps --chown=node:node /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules

COPY --from=build --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/migrations ./apps/server/migrations
# The server serves this directory (resolved as ../../web/dist from apps/server/dist).
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

USER node
# Render injects PORT (default 10000); the server listens on 0.0.0.0:$PORT. EXPOSE is informational.
EXPOSE 10000
CMD ["node", "apps/server/dist/main.js"]
