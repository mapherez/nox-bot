# NoX Bot deployment

The same Compose stack supports `linux/amd64` and `linux/arm64`, with no primary hardware platform. Node 24 runs the bot and dashboard. SpacetimeDB 2.10.2 runs on the same host with private networking and persistent data/signing-key volumes.

## Prepare

1. Copy `.env.example` to `.env` and set the bot token, application ID, OAuth secret, explicit owner ID, public HTTPS origin and two separate base64 keys.
2. Register `https://YOUR_HOST/auth/callback` in Discord Developer Portal. Enable Message Content intent if using Quick Commands.
3. Configure the existing HTTPS proxy to `127.0.0.1:3200`. Proxy `/auth/*`, `/dashboard/api/*` and assets on the same origin. Disable buffering for SSE and allow long-lived event streams. The application determines Secure cookies from `NOX_BOT_PUBLIC_URL`, rather than trusting arbitrary forwarded headers.

```sh
docker compose build
docker compose up -d
docker compose logs --tail 100 nox-bot state-init
```

The controlled `state-init` service creates the publisher and service identities, publishes the module and authorizes only the service through an owner-checked reducer. The application mounts only service credentials read-only; it cannot authorize arbitrary clients. The publisher volume is mounted only by the initializer. Module updates use migration preflight and never request deletion of database state.

The one-shot `state-volume-init` sets ownership and private permissions on new data/signing volumes before the official DB server runs as its unprivileged user. Data and signing keys survive container recreation.

The dashboard is published in loopback. The database has no published port. Do not add a public DB port for the dashboard: browsers communicate only with the backend API and sanitized SSE.

## Optional Control API

Provide an independent `NOX_BOT_API_KEY` and enable the existing override:

```sh
docker compose -f docker-compose.yml -f docker-compose.api.yml up -d
```

The Control API publishes only a loopback port by default. `/v1` bearer authentication, validation and error contracts are preserved. It uses the same live Discord client and permissions as the dashboard and bot.

## Migration

Run the explicit import script with a mandatory guild ID and old JSON path after initialization. Use dry run first; consult the main README. No JSON file is mounted into the application, and the legacy Weather key is only read when explicitly selected by the importer.

## Backups and shutdown

Back up the `spacetime-data`, `spacetime-signing`, `state-publisher` and `state-service` volumes together with the external encryption/session keys and deployment secrets. Signing keys must persist so saved identity tokens remain valid. Treat credential volumes as secrets. Take consistent DB backups while the service is stopped or using the server's supported backup facilities.

```sh
docker compose stop
docker compose start
```

The bot stops accepting HTTP work, closes SSE, disposes plugin processes and disconnects Discord. Its internal deadline is ten seconds; Compose grants fifteen seconds. Plugin dispose has a timeout followed by forced termination. A DB interruption after initialization keeps the last confirmed runtime operational. A cold start awaits a confirmed snapshot.

## Existing image workflow

The existing manual GitHub workflow builds `linux/arm64,linux/amd64` for `ghcr.io/mapherez/nox-bot`. Compose and the workflow's image-tag input default to `latest`; set `NOX_BOT_IMAGE_TAG` to select another existing image tag. Image tags are independent of the application's runtime version. Do not run the publishing workflow merely to validate locally. Configure Discord branding and the OAuth callback separately in Developer Portal.

## SpacetimeDB on ARM64 hosts with 16 KB pages

The pinned official SpacetimeDB image can fail before startup on a 16 KB kernel with `jemalloc: Unsupported system page size`. The controlled initializer then times out because no DB becomes available. This requires a compatible DB binary, not a longer initialization timeout.

`Build SpacetimeDB image` is a separate, manual GitHub Action. Run it from `main` after committing the recipe. It builds and tests native AMD64 and ARM64 images before publishing `ghcr.io/mapherez/nox-spacetimedb:2.10.2-pages64k`. Both server and CLI remain version 2.10.2, from the pinned upstream commit. Only ARM64 receives `JEMALLOC_SYS_WITH_LG_PAGE=16`; AMD64 retains upstream allocator defaults. Functional contracts remain the same, but ARM64 memory use and performance can differ.

The action verifies versions, build metadata, runtime layout, the real DB integration cases and Compose persistence before publishing each architecture by digest. It verifies the merged manifest against those digests and publishes the version tag plus a recipe-commit tag. The summary contains the exact reference for deployment. Publishing does not change package visibility: first review the manifest/digests, then make the `nox-spacetimedb` package public manually once in GitHub Packages. No extra registry credentials are required for public pulls.

### Validate a published candidate on the 16 KB host

The repository deliberately keeps the previous official image defaults until a custom image has been published and validated. Do not change the host kernel. First confirm `getconf PAGESIZE` returns `16384` and select the published digest in your shell (never a placeholder):

```sh
export NOX_BOT_SPACETIMEDB_IMAGE=ghcr.io/mapherez/nox-spacetimedb@sha256:ACTUAL_PUBLISHED_DIGEST
docker pull "$NOX_BOT_SPACETIMEDB_IMAGE"
npm ci
node scripts/test-spacetime-image.mjs arm64
npm run typecheck
npm test
npm run test:state
docker buildx build --builder default --platform linux/arm64 --build-arg "NOX_BOT_SPACETIMEDB_IMAGE=$NOX_BOT_SPACETIMEDB_IMAGE" --load -t nox-bot:validation-arm64 .
node scripts/test-compose.mjs arm64
```

These harnesses never load deployment `.env`, log into Discord or mount production volumes. The DB integration test uses a disposable container and private fixture credentials; Compose uses a unique project with temporary named volumes, preserving the official image for `state-volume-init`. The tests exercise module publication, authenticated subscriptions/writes, outage recovery and persistence after server recreation. Native build tooling for `nodehun` is required as described in the README. The test output reports the container kernel page size and an end-of-test DB memory sample; record these with the exit status and observation period. The sample is not a performance comparison. Passing a 4 KB runner does not establish compatibility with a 16 KB host.

### Pin the validated digest and deploy

After the 16 KB smoke succeeds, take a consistent backup and record the previous digest. In one reviewed change, replace the DB image reference in the `spacetimedb` service, the default `NOX_BOT_SPACETIMEDB_IMAGE` build argument in the bot Dockerfile and `DEFAULT_SPACETIME_IMAGE` in `scripts/spacetime-image.mjs` with the same published multiarchitecture digest. Keep `state-volume-init` and the runtime base in the custom image recipe on the original official digest. Do not replace those references in a global search/replace.

Run the normal checks and the existing bot image workflow to rebuild/publish the bot with the validated toolchain. On the deployment host, pull `spacetimedb`, `state-init` and `nox-bot`, then run `docker compose up -d` without `--build`; check DB and initializer logs. Preserve every existing volume, credential mount and private network. Never use `docker compose down --volumes` for this rollout. No storage migration is needed for the same SpacetimeDB version. Later publications do not change the pinned deployment until its digest is explicitly updated.
