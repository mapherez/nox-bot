# syntax=docker/dockerfile:1.7
FROM rust:1.96.1-bookworm@sha256:a339861ae23e9abb272cea45dfafde21760d2ce6577a70f8a926153677902663 AS builder
ARG TARGETARCH
ENV CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git pkg-config libssl-dev clang cmake python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/spacetimedb
RUN git init . && git remote add origin https://github.com/clockworklabs/SpacetimeDB.git && git fetch --depth=1 origin refs/tags/v2.10.2 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = "58d2a40718c59535fd5c267e836d473298eb84d5"
# The caches and build layer are architecture-specific. AMD64 keeps upstream defaults.
RUN --mount=type=cache,id=spacetime-58d2a40718c59535fd5c267e836d473298eb84d5-${TARGETARCH}-pages64k-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=spacetime-58d2a40718c59535fd5c267e836d473298eb84d5-${TARGETARCH}-pages64k-git,target=/usr/local/cargo/git \
    case "$TARGETARCH" in \
      arm64) export JEMALLOC_SYS_WITH_LG_PAGE=16; allocator=16 ;; \
      amd64) unset JEMALLOC_SYS_WITH_LG_PAGE; allocator=upstream ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    printf 'SpacetimeDB 2.10.2: architecture=%s, JEMALLOC_SYS_WITH_LG_PAGE=%s\n' "$TARGETARCH" "${JEMALLOC_SYS_WITH_LG_PAGE-unset (upstream)}" && \
    cargo build --locked --release -p spacetimedb-standalone -p spacetimedb-cli && \
    printf '{"version":"2.10.2","upstreamCommit":"58d2a40718c59535fd5c267e836d473298eb84d5","architecture":"%s","jemallocLgPage":"%s"}\n' "$TARGETARCH" "$allocator" > /usr/src/spacetimedb/nox-build-info.json
RUN printf 'Upstream commit: %s\n' "$(git rev-parse HEAD)" && rustc --version

# Retain the official image's dependencies, entrypoint, user and filesystem layout.
FROM clockworklabs/spacetime@sha256:acf3210403559f731e222fb77042aac32429d7ea77a4858ffa68bd459383069d AS runtime
COPY --from=builder --chmod=755 /usr/src/spacetimedb/target/release/spacetimedb-standalone /usr/src/spacetimedb/target/release/spacetimedb-cli /opt/spacetime/
COPY --from=builder /usr/src/spacetimedb/nox-build-info.json /opt/spacetime/nox-build-info.json
COPY --from=builder /usr/src/spacetimedb/LICENSE.txt /usr/share/doc/nox-spacetimedb/LICENSE.txt
LABEL org.opencontainers.image.source="https://github.com/mapherez/nox-bot" \
      org.opencontainers.image.version="2.10.2" \
      org.opencontainers.image.description="SpacetimeDB with jemalloc pages64k on ARM64 and upstream allocator defaults on AMD64" \
      io.nox.spacetimedb.upstream-revision="58d2a40718c59535fd5c267e836d473298eb84d5"
