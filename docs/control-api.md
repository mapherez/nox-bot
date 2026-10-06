# NoX Bot control API v1

The control API is an optional machine-readable interface for external clients, including a future NoX CLI. It runs inside the NoX Bot process and uses the same Discord Client and shared messaging services as the bot and dashboard. Its `/v1` contracts are independent of the owner-only dashboard API.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOX_BOT_API_ENABLED` | `false` | Exactly `true` enables HTTP. A key alone does not enable it. |
| `NOX_BOT_API_HOST` | `127.0.0.1` | Bind IP address or `localhost`; IPv6 is supported. |
| `NOX_BOT_API_PORT` | `3100` | Port from 1 to 65535. |
| `NOX_BOT_API_KEY` | unset | Required when enabled; no whitespace; must differ from the Discord token, including its normalized form. |
| `NOX_BOT_VERSION` | unset | Optional runtime application-version override. |

Discord uses `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Guild selection comes from the real client; plugin settings and encrypted secrets are stored per guild in SpacetimeDB and managed through the dashboard's Plugins page. Quick Commands are managed on their own dashboard page. Guild command registrations reconcile automatically at startup, relevant configuration changes, guild installation and Discord recovery; no manual refresh is needed. The Control API does not read the legacy Weather key or command JSON.

Generate a separate random key:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Store it in your private `.env`; do not reuse `DISCORD_TOKEN`. With HTTP enabled, invalid configuration or a failed bind prevents startup and triggers cleanup. Without HTTP enabled, no listener is created and no key is required.

```dotenv
NOX_BOT_API_ENABLED=true
NOX_BOT_API_HOST=127.0.0.1
NOX_BOT_API_PORT=3100
NOX_BOT_API_KEY=<your-separate-random-key>
```

## Authentication and access

`GET /v1/health` and `GET /v1/info` are public. All other routes require:

```http
Authorization: Bearer <API_KEY>
```

Use one Authorization header, with the literal `Bearer` scheme. Credentials in URLs are not accepted. One key grants access to the supported operations across guilds the bot can access. There is no per-client authorization or OAuth. The Discord token never authenticates this API. Responses do not include credentials, upstream error bodies or stacks; logging redacts configured credentials and avoids request dumps.

By default HTTP is local. Remote access requires explicitly configuring the bind and network exposure; use HTTPS through your deployment's reverse proxy or a private tunnel for access beyond the host. The dashboard is served on a separate listener with owner-only Discord OAuth, `/auth/*`, `/dashboard/api/*` and authenticated SSE on the same origin. Dashboard sessions do not authenticate `/v1`; the Control API does not provide browser CORS integration.

## Response contracts

All application responses use JSON (`application/json; charset=utf-8`) and `Cache-Control: no-store`. IDs are decimal strings, never JSON numbers. Clients should tolerate additional response fields in future compatible v1 updates and depend on error `code`, not `message`. Breaking contract changes require a new API version.

### GET /v1/health — public

```json
{
  "service": "nox-bot",
  "version": "v1.2.3",
  "apiVersion": "v1",
  "ready": true,
  "process": { "state": "running" },
  "discord": { "state": "connected", "ready": true }
}
```

Returns HTTP 200 only after initialization completes and Discord is ready. Otherwise returns 503 with the same health shape, rather than an error document. Process states: `starting`, `running`, `stopping`. Discord states: `connecting`, `connected`, `reconnecting`, `disconnected`.

Health reads local state without REST requests. The listener remains available through reconnections and readiness returns automatically when Discord recovers. During shutdown the listener closes, so clients may observe a connection failure rather than a final health response.

The dashboard listener's `GET /health` separately exposes database synchronization and functional readiness. A cold process waits for a confirmed SpacetimeDB snapshot before completing initialization. After initialization, a DB interruption preserves the last confirmed runtime, including messaging and command reconciliation. Persistent configuration changes and new dashboard sessions remain blocked until synchronization recovers; existing confirmed sessions remain usable within their expiry limits.

### GET /v1/info — public

Always returns 200 while HTTP is serving, independently of Discord readiness:

```json
{
  "service": "nox-bot",
  "version": "v1.2.3",
  "apiVersion": "v1",
  "capabilities": ["discord-status", "guilds", "channels", "messages"]
}
```

### GET /v1/status — authenticated

Returns 200 even during a Discord disconnect:

```json
{
  "discord": { "state": "connected", "ready": true, "pingMs": 42 },
  "bot": { "id": "123456789", "username": "NoX" },
  "guildCount": 3
}
```

`bot` is `null` before identity is known. `pingMs` is `null` when disconnected or without a valid measurement; it represents Gateway heartbeat latency, not a fresh REST round trip. `guildCount` counts the Client's currently known cached guilds.

### GET /v1/guilds — authenticated

```json
{ "guilds": [{ "id": "123456789", "name": "My server" }] }
```

Returns 200, listing only ID/name from the bot's guild cache. Requires initialization and Discord readiness. Ordered by ID, without pagination. Guild commands are reconciled automatically for each installed server.

### GET /v1/guilds/:guildId/channels — authenticated

```json
{
  "guildId": "123456789",
  "channels": [{ "id": "987654321", "name": "general", "type": "text" }]
}
```

Returns 200 with REST-fetched channels where the bot has effective `ViewChannel` and `SendMessages` permissions. Types are `text` or `announcement`; DMs, threads, forums, categories, voice and stage are excluded. Overwrites and applicable member restrictions are respected. An existing guild with no sendable channels returns an empty array. Results are ordered by ID.

### POST /v1/messages — authenticated

```json
{ "channelId": "987654321", "content": "test message" }
```

Returns 201 after Discord accepts the send:

```json
{ "messageId": "111222333", "channelId": "987654321", "guildId": "123456789" }
```

Only `channelId` and `content` are accepted. Content must be a string, contain something other than whitespace, and be at most 2000 UTF-16 code units. `trim()` is used solely to check emptiness; the original content, including leading/trailing whitespace, is passed to Discord unchanged. Discord may apply its normal content processing.

IDs must be positive decimal strings within the unsigned 64-bit range. Require `Content-Type: application/json` (optional UTF-8 charset); body limit is 16 KiB, including chunked bodies. Channels and permissions are checked again on send. Mentions work normally and can notify users, roles or everyone according to Discord permissions. Announcement messages are not automatically crossposted.

No attachments, explicit embeds, replies, history, edits, deletion or management operations are supported. Normal Discord link previews may still appear. The API adds no send retries and offers no idempotency guarantee. If the connection fails after submission, a message might already exist; automatic client retry can duplicate it.

## Errors

```json
{ "code": "CHANNEL_NOT_FOUND", "message": "Channel not found." }
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `AUTH_REQUIRED` | Authorization header absent. |
| 401 | `AUTH_INVALID` | Invalid credential, scheme or duplicate headers. |
| 400 | `INVALID_PAYLOAD` | Invalid JSON, ID, content or fields. |
| 400 | `INVALID_CHANNEL` | Channel type outside the supported scope. |
| 404 | `GUILD_NOT_FOUND` | Guild unknown to the bot or removed. |
| 404 | `CHANNEL_NOT_FOUND` | Channel does not exist. |
| 403 | `INSUFFICIENT_PERMISSIONS` | Missing access or send permissions. |
| 503 | `DISCORD_UNAVAILABLE` | Client/guild unavailable or transient Discord request failure. |
| 503 | `SERVICE_UNAVAILABLE` | Operation unavailable during startup/shutdown. |
| 422 | `MESSAGE_REJECTED` | Discord specifically blocks the message, such as AutoMod. |
| 413 | `PAYLOAD_TOO_LARGE` | Body exceeds 16 KiB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported Content-Type. |
| 404 | `ROUTE_NOT_FOUND` | Unknown route. |
| 405 | `METHOD_NOT_ALLOWED` | Incorrect method; `Allow` states the supported method. |
| 500 | `INTERNAL_ERROR` | Unexpected failure with details omitted. |

Protected routes authenticate before parsing bodies or accessing Discord. Discord.js retains its normal internal rate-limit queues/retries; events and waiting do not produce HTTP 429. No artificial `RATE_LIMITED` response is implemented. Low-level malformed HTTP, connection failures and Node transport timeouts are transport failures and need not contain the application JSON error contract.

## Examples

Set `NOX_BOT_API_KEY` in your shell for authenticated examples:

```sh
curl http://127.0.0.1:3100/v1/health
curl http://127.0.0.1:3100/v1/info
curl -H "Authorization: Bearer $NOX_BOT_API_KEY" http://127.0.0.1:3100/v1/status
curl -H "Authorization: Bearer $NOX_BOT_API_KEY" http://127.0.0.1:3100/v1/guilds
curl -H "Authorization: Bearer $NOX_BOT_API_KEY" http://127.0.0.1:3100/v1/guilds/123456789/channels
curl -X POST -H "Authorization: Bearer $NOX_BOT_API_KEY" \
  -H "Content-Type: application/json" \
  --data '{"channelId":"987654321","content":"test message"}' \
  http://127.0.0.1:3100/v1/messages
```

## Versions and Docker

The application resolves one version at startup: nonblank `NOX_BOT_VERSION`, then incorporated `dist/build-info.json`, then `dev`. Health and info share exactly that value. Local source runs and builds without explicit build metadata use `dev`, irrespective of the package version.

The Docker workflow fetches history/tags and uses `git describe --tags --exact-match HEAD` for an exact tag (including that command's selection when several tags coexist). Otherwise it uses `git-<full HEAD SHA>`. The build receives `NOX_BOT_BUILD_VERSION`; no manual application-version workflow input exists. The Docker image-tag input defaults to `latest` and remains independent of this runtime version. To supply metadata to a local build, set `NOX_BOT_BUILD_VERSION` when running `npm run build`, or use the Docker build argument with the same name.

The base Compose runs the bot/dashboard, private SpacetimeDB and one-shot volume/bootstrap initializers. It publishes the dashboard only at `127.0.0.1:${NOX_BOT_DASHBOARD_PORT:-3200}`; the DB has no published port. Both application services use `ghcr.io/mapherez/nox-bot:${NOX_BOT_IMAGE_TAG:-latest}`. See [deployment](../DEPLOYMENT.md) for provisioning, persistent volumes and the existing HTTPS proxy setup. For local Control API access, configure its separate `NOX_BOT_API_KEY` in `.env` and run:

```sh
docker compose -f docker-compose.yml -f docker-compose.api.yml up -d
```

The override enables the Control API with `NOX_BOT_API_ENABLED`, binds to `0.0.0.0` inside the container, publishes only `127.0.0.1:${NOX_BOT_API_PORT:-3100}` on the host, and allows 15 seconds for shutdown. Quick Commands and plugin settings use SpacetimeDB; there is no runtime command-JSON mount. To expose access beyond the host, explicitly change publication and use your chosen private network/tunnel or HTTPS proxy. The image supports `linux/amd64` and `linux/arm64`, including native `nodehun` on both architectures.

SIGINT/SIGTERM and fatal failures share bounded cleanup: stop new HTTP work, drain accepted operations, close SSE and DB subscriptions, dispose plugin workers and destroy the existing Client. Startup cannot continue after shutdown. Normal cleanup is idempotent with a total 10-second deadline.

## Validation

Run `npm run typecheck`, `npm test` and `npm run test:state`. The suite builds the backend/dashboard and tests contracts over local HTTP, Discord operations with fake managers and real local permission objects, version resolution, logging, reconciliation, commands and lifecycle. The state harness builds the module and runs real self-hosted SpacetimeDB integration checks, including outage/recovery. These checks do not load deployment `.env` or log into Discord. CI uses Node 24 and runs before image publication. See [validation](validation.md) for the existing multiarchitecture Docker/Compose checks.

For live acceptance in a development guild, enable Ping through the dashboard and check `/ping`, an enabled Quick Command, automatic guild command reconciliation, API channel selection, a successful message, denied-channel handling, readiness after reconnection, and `docker compose stop`. These checks require an explicitly configured live Discord deployment and are separate from the offline suite.
