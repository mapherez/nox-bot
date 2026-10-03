# Nox Discord Bot - Pi 5 Docker deployment files

## Files to copy into the repo

```txt
Dockerfile
.dockerignore
.github/workflows/docker-image.yml
```

## File to copy onto the Raspberry Pi

```txt
docker-compose.yml
docker-compose.api.yml # Optional, only when enabling the control API.
.env.example
```

Rename `.env.example` to `.env` on the Pi and fill in your real tokens.

## Production module loading

The current loaders already accept both `.ts` and compiled `.js` files. No production loader patch is needed.

## Build image manually from GitHub

Go to:

```txt
GitHub → Actions → Build Docker image → Run workflow
```

Use:

```txt
tag: pi5
push_latest: true
```

This publishes:

```txt
ghcr.io/mapherez/nox-discord-bot:pi5
ghcr.io/mapherez/nox-discord-bot:latest
```

Publication requires the offline test suite to pass. The internal application version is the exact Git tag on the published commit, or `git-<full commit SHA>` when untagged. Docker tags `pi5` and `latest` do not determine that version. An optional `NOX_DISCORD_VERSION` runtime override takes precedence; unversioned local builds use `dev`. Published platforms remain `linux/arm64`.

## Optional local control API

Set a separate `NOX_DISCORD_API_KEY` in `.env`, copy `docker-compose.api.yml` to the Pi, and use:

```bash
docker compose -f docker-compose.yml -f docker-compose.api.yml up -d
```

The override enables HTTP inside the container and publishes port 3100 only on the Pi's loopback address. `NOX_DISCORD_API_PORT` can change that port. The base Compose continues to publish no port; the prefix-command mount is preserved. The override allows 15 seconds for graceful shutdown.

See [control API documentation](docs/control-api.md) for authentication, endpoint contracts, versioning and explicit remote-access configuration.

## On the Raspberry Pi 5

Create a folder:

```bash
mkdir -p ~/docker/nox-discord-bot
cd ~/docker/nox-discord-bot
```

Copy these files into it:

```txt
docker-compose.yml
.env
prefix-commands.json
```

Then run:

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

## Update later

```bash
cd ~/docker/nox-discord-bot
docker compose pull
docker compose up -d
```
