# syntax=docker/dockerfile:1.7
ARG NOX_BOT_SPACETIMEDB_IMAGE=clockworklabs/spacetime@sha256:acf3210403559f731e222fb77042aac32429d7ea77a4858ffa68bd459383069d
FROM ${NOX_BOT_SPACETIMEDB_IMAGE} AS spacetime-toolchain
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config libhunspell-dev && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY web/package.json ./web/package.json
COPY spacetimedb/package.json ./spacetimedb/package.json
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY spacetimedb ./spacetimedb
COPY --from=spacetime-toolchain /opt/spacetime /opt/spacetime
COPY --from=spacetime-toolchain /usr/local/bin/spacetime /usr/local/bin/spacetime
ARG NOX_BOT_BUILD_VERSION=dev
RUN NOX_BOT_BUILD_VERSION="$NOX_BOT_BUILD_VERSION" npm run typecheck && npm run build && npm run build:web && mkdir -p spacetimedb/node_modules/.bin && ln -s /app/node_modules/typescript/bin/tsc spacetimedb/node_modules/.bin/tsc && spacetime build --module-path spacetimedb
RUN npm prune --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libhunspell-1.7-0 && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 nox && useradd --uid 10001 --gid nox --home-dir /app --no-create-home nox
COPY --from=build --chown=nox:nox /app/package*.json ./
COPY --from=build --chown=nox:nox /app/node_modules ./node_modules
COPY --from=build --chown=nox:nox /app/dist ./dist
COPY --from=build --chown=nox:nox /app/web/dist ./web/dist
COPY --from=build --chown=nox:nox /app/spacetimedb/dist ./spacetimedb/dist
COPY --from=build --chown=nox:nox /app/scripts ./scripts
USER nox
EXPOSE 3200
CMD ["node", "dist/index.js"]
