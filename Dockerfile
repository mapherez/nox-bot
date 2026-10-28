# syntax=docker/dockerfile:1.7
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config libhunspell-dev && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY web/package.json ./web/package.json
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
ARG NOX_BOT_BUILD_VERSION=dev
RUN NOX_BOT_BUILD_VERSION="$NOX_BOT_BUILD_VERSION" npm run typecheck && npm run build && npm run build:web
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24.22.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libhunspell-1.7-0 && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 nox && useradd --uid 10001 --gid nox --home-dir /app --no-create-home nox
COPY --from=build --chown=nox:nox /app/package*.json ./
COPY --from=build --chown=nox:nox /app/node_modules ./node_modules
COPY --from=build --chown=nox:nox /app/dist ./dist
COPY --from=build --chown=nox:nox /app/web/dist ./web/dist
COPY --from=build --chown=nox:nox /app/scripts ./scripts
# Docker initializes an empty named volume from this directory, including its owner.
# Runtime stays unprivileged; no root bootstrap or host permission changes.
RUN mkdir -p /app/data && chown nox:nox /app/data && chmod 700 /app/data
USER nox
RUN node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(":memory:"); if (db.prepare("SELECT 1 AS ready").get().ready !== 1) process.exit(1); db.close();'
# Fail the build on either target architecture if native voice dependencies cannot load.
# Audio is converted in-process; FFmpeg is not used.
RUN node --input-type=module -e 'import opus from "@discordjs/opus"; import { generateDependencyReport } from "@discordjs/voice"; const codec = new opus.OpusEncoder(48000, 2); if (codec.decode(codec.encode(Buffer.alloc(3840))).length !== 3840 || !/@snazzah\/davey: 0\./.test(generateDependencyReport())) process.exit(1);'
EXPOSE 3200
CMD ["node", "dist/index.js"]
