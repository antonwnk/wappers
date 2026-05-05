# syntax=docker/dockerfile:1.7
# Multi-stage so runtime stays small: build tools live only in the builder layer.
# better-sqlite3 is a native module — node-gyp needs python + a C++ toolchain to build it.

ARG NODE_VERSION=22-alpine

# ---- builder -------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

# Native build deps for better-sqlite3 (and any other prebuild-fallback modules).
RUN apk add --no-cache python3 make g++ libc6-compat

# Use the same pnpm version as in development. corepack ships with Node 22.
RUN corepack enable

# Install deps first (cached layer) — only re-runs when manifests change.
COPY package.json pnpm-lock.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# Now copy sources and build.
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# Strip dev deps from node_modules so we copy only what runtime needs.
# better-sqlite3's compiled .node binary is preserved.
RUN pnpm prune --prod

# ---- runtime -------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

# libstdc++ is needed at runtime for the better-sqlite3 native binding under musl.
RUN apk add --no-cache libstdc++

# Run as non-root. node:alpine ships a `node` user (uid 1000).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    BRIDGE_CONFIG=/app/config.yaml

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node package.json ./

# Persist auth state + outbox sqlite across restarts. Mount your config.yaml in too.
VOLUME ["/app/data"]
EXPOSE 3000

# No tini/dumb-init — Node responds to SIGTERM directly and our shutdown handler
# drains the dispatcher and closes the store cleanly.
CMD ["node", "dist/index.js"]
