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
