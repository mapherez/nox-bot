# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app

# nodehun is a native dependency, so the builder needs native build tooling.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    pkg-config \
    libhunspell-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ARG NOX_DISCORD_BUILD_VERSION=dev
RUN NOX_DISCORD_BUILD_VERSION="$NOX_DISCORD_BUILD_VERSION" npm run build

# Keep compiled production dependencies from the builder so native modules do not rebuild in runtime.
RUN npm prune --omit=dev \
  && npm cache clean --force


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    libhunspell-1.7-0 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system nox \
  && useradd --system --gid nox --home-dir /app nox \
  && chown -R nox:nox /app

COPY --from=build --chown=nox:nox /app/package*.json ./
COPY --from=build --chown=nox:nox /app/node_modules ./node_modules
COPY --from=build --chown=nox:nox /app/dist ./dist

USER nox

CMD ["node", "dist/index.js"]
