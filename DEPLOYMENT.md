# NoX Bot deployment

The image supports `linux/amd64` and `linux/arm64`. Node 24.22.1 runs the bot/dashboard and includes SQLite. The Compose stack contains one application service with one persistent data volume. The schema is created automatically; there is no separate database service or initializer.

## Prepare and run

1. Copy `.env.example` to `.env`. Configure the Discord bot token, application ID, OAuth secret, explicit owner ID, browser origin and the two separate base64 keys.
2. Register the exact origin's `/auth/callback` in Discord Developer Portal. Enable Message Content intent for Quick Commands.
3. Keep `NOX_BOT_DATABASE_PATH=./data/nox-bot.sqlite`. Inside the image, the working directory is `/app`, so this resolves to `/app/data/nox-bot.sqlite`, inside the `bot-data` volume.
4. Use the published image or build it with the existing GitHub workflow. Start the deployment:

```sh
docker compose up -d
docker compose logs --tail 100 nox-bot
```

The default publication is `127.0.0.1:3200`. An existing HTTPS proxy/tunnel can forward to this listener. Keep assets, `/auth/`, `/dashboard/api/` and `/mcp/` on the configured origin. Disable proxy buffering for SSE and allow long-lived responses.

The image runs as UID/GID **10001**. `/app/data` is prepared with that owner and mode 0700 at image build time; Docker preserves this when initializing a new named volume. SQLite creates its file with mode 0600. The application does not use a privileged runtime bootstrap or change host ownership/permissions. A custom bind-mounted data directory must already be writable by UID/GID 10001.

## SQLite storage

The database persists Quick Commands, plugin configuration, encrypted plugin secrets, owner authorization, sessions and legacy import markers. Keep `NOX_BOT_ENCRYPTION_KEY` and `NOX_BOT_SESSION_SECRET` in the deployment environment as before. No DB URL, DB token or DB identity files are needed.

`NOX_BOT_DATABASE_PATH` is the file path **inside the application environment**, not a host directory. The default works both in the container (`/app/data/nox-bot.sqlite`) and during local development (`data/nox-bot.sqlite` relative to the repo). Changing the container path requires mounting its parent directory persistently as well. The standard setup requires no additional path variable.

SQLite uses WAL and FULL synchronization in a dedicated worker thread. The complete validated Quick Commands import is a single transaction, including lists over 1000 commands. Dashboard updates still travel over the application's existing SSE endpoint. Run one bot instance per database file and keep the volume on local storage rather than a network filesystem.

## Existing deployments

Follow [SQLite migration](docs/SQLITE-MIGRATION.md) for the removed services, volumes and environment variables. The transition starts with a new SQLite database and restores Quick Commands using the exported JSON. It does not read or convert the old database automatically.

## Direct LAN dashboard access

Set `NOX_BOT_DASHBOARD_BIND_ADDRESS` to the desired host interface and `NOX_BOT_PUBLIC_URL` to the exact browser origin, including the chosen host port. Register that origin's `/auth/callback` with Discord. Compose keeps the internal listener at `0.0.0.0:3200`; the host mapping is independent.

HTTP accepts localhost/loopback, private IPv4 addresses and IPv6 unique-local addresses. HTTPS accepts a hostname. HTTPS cookies are Secure; HTTP LAN cookies retain HttpOnly and SameSite=Lax. Owner authorization and exact Origin/CSRF validation apply in both cases.

## Optional voice integration

Follow [NoX Voice](docs/VOICE.md). The optional override mounts only the existing three client certificate files for the nox-voice-mlx controller. It is independent of the SQLite data volume. Keep the configured HTTPS controller URL and client-file environment variables unchanged during this storage migration.

If your main file is `docker-compose.yml`, use `docker-compose.override.yml`. If it is `compose.yaml`, use `compose.override.yaml`. Matching default override names are loaded automatically by `docker compose up -d`.

## Optional Control API

Provide the independent `NOX_BOT_API_KEY` and enable the existing explicit override:

```sh
docker compose -f docker-compose.yml -f docker-compose.api.yml up -d
```

When using explicit `-f` arguments, include the voice override as another `-f` if required; automatic override discovery is replaced by the supplied list. The Control API keeps its bearer authentication, routes and loopback port publication.

## Backups and shutdown

Use **Quick Commands → ⋮ → Export commands** for a portable JSON backup. To back up all application data, stop the bot and snapshot/copy the entire `bot-data` volume, retaining the external encryption/session keys separately. SQLite can have `-wal`/`-shm` files while open; copying only the main `.sqlite` file during writes is not a complete backup.

```sh
docker compose stop nox-bot
# Back up the bot-data volume using the host's volume/snapshot tooling.
docker compose start nox-bot
```

Container recreation and image updates retain the named volume. The bot drains HTTP work, closes SSE, disposes plugins, closes SQLite and disconnects Discord on shutdown. Its internal deadline is ten seconds and Compose allows fifteen seconds.

The existing healthcheck uses the Node runtime every 30 seconds with a 5-second timeout, three retries and a 60-second startup grace period. Functional readiness and storage synchronization are reported separately. A storage-worker failure after startup preserves cached command functionality while recovery is attempted; a cold start requires the database to open successfully. Healthchecks report status and do not themselves restart unhealthy containers.

## Build and validation

```sh
npm ci
npm run typecheck
npm test
npm run test:state
```

`npm test` includes the real SQLite integration cases without Docker. CI also builds and smoke-tests the production image and fresh named-volume persistence for AMD64 and ARM64. The manual image workflow retains its existing GHCR name and tagging behaviour. Local validation does not publish images or modify the deployed bot.
