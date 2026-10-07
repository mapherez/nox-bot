# Guild MCP

NoX Bot exposes an always-on, unauthenticated Streamable HTTP MCP endpoint for each installed Discord server, using `@nox/mcp` v0.4.1. MCP is part of the existing process and dashboard listener; there is no separate Discord client, token, port or activation flag.

Copy **Server MCP URL** from the dashboard's **Server** tab into your client. The URL is built from the validated `NOX_BOT_PUBLIC_URL` origin:

```text
https://bot.example.com/mcp/guilds/123456789
```

For local development, use your configured public origin, for example `http://127.0.0.1:3200/mcp/guilds/123456789`. A reverse proxy must forward `/mcp/` to the dashboard listener. The copied URL uses the configured backend origin even when the dashboard is opened through Vite.

The stateless HTTP transport returns JSON for `initialize`, `tools/list` and `tools/call`, matching NoX Yard. In Postman, POST JSON with `Content-Type: application/json`; `Accept: application/json`, the default `*/*` or an omitted Accept header work without adding `text/event-stream`. Standard MCP clients advertising both JSON and SSE also receive JSON. Initialization notifications return HTTP 202 with an empty body. No MCP session ID is required; GET and DELETE session endpoints return 405. The SDK's modern per-request protocol remains supported.

`@nox/mcp` v0.4.1's TypeScript helper fixes the 2025 transport to SSE and does not expose a JSON option. A small HTTP adapter composes the SDK's stateless JSON transport with the same NoX server factory, preserving the library's tool validation, execution limits and cancellation. No business logic runs in this adapter.

No Authorization header, cookie or CSRF token is needed. Anyone with network access to a guild's endpoint can use all of its tools. The dashboard remains owner-authenticated and the Control API keeps its independent bearer authentication.

## Tools

All inputs are objects. IDs and revisions are strings. The server ID comes exclusively from the URL: extra fields, including `guildId`, are rejected. `_meta.cli` contains only the app-relative command below.

| Tool | `_meta.cli` | Arguments |
| --- | --- | --- |
| `status` | `status` | `{}` |
| `guild_get_id` | `guild get id` | `{}` |
| `channel_list` | `channel list` | `{}` |
| `message_send` | `message send` | `channelId`, `content` |
| `command_list` | `command list` | `{}` |
| `plugin_list` | `plugin list` | `{}` |
| `plugin_get` | `plugin get` | `pluginId` |
| `plugin_enable` | `plugin enable` | `pluginId`, `expectedRevision` |
| `plugin_disable` | `plugin disable` | `pluginId`, `expectedRevision` |
| `plugin_configure` | `plugin configure` | `pluginId`, `settings`, `expectedRevision`, optional `secrets` |
| `quick_command_list` | `quick-command list` | `{}` |
| `quick_command_create` | `quick-command create` | `trigger`, `response`, `enabled` |
| `quick_command_update` | `quick-command update` | `trigger`, `response`, `enabled`, `expectedRevision` |
| `quick_command_delete` | `quick-command delete` | `trigger`, `expectedRevision` |

`status` exposes this guild's synchronization and command registration state alongside the shared process and Discord connection status. It does not expose the inventory of other guilds. `channel_list` includes only supported channels where the bot can view and send messages. `message_send` uses the existing guild messaging service, checks current channel permissions and membership, and suppresses mentions. It cannot target another guild or a DM.

`command_list` lists currently available Discord command definitions, including enabled plugins, without executing them. `guild_list`, `weather`, `dictionary_lookup`, `user_info` and `ping` are not registered. Plugin management remains available.

## Confirmed configuration

Plugin and Quick Command reads reuse the dashboard DTOs. Successful configuration changes return the confirmed guild snapshot, including the latest per-record revisions and MCP URL. Plugin secrets are represented only as `{ configured: boolean }`; neither plaintext nor encrypted secrets are returned.

Read the current revision before updating, deleting, enabling, disabling or configuring a record. New plugin configurations use `"0"`; `quick_command_create` supplies `"0"` internally and therefore refuses to overwrite an existing trigger. Quick Command normalization and validation remain in the existing service. Updating uses the existing trigger rather than a rename operation.

`plugin_configure` replaces settings according to the plugin's existing validator. Omitted secret fields are preserved, string values replace them, and `null` removes them. Existing validation determines whether a plugin may be enabled or reconfigured.

During a DB interruption, reads use the last confirmed state and Discord messaging continues while Discord is ready. Persistent changes return `STATE_UNAVAILABLE` until recovery has completed. Revision conflicts return `STATE_CONFLICT`. `WRITE_UNCONFIRMED` and cancelled/timed-out mutations can report `details.outcome: "unknown"`: inspect confirmed state before retrying. Writes are never queued or automatically replayed.

The server uses NoX MCP's default execution timeout, payload and concurrency settings. Client cancellation is checked before effects and after asynchronous guild/channel resolution. Shutdown rejects new MCP work and drains accepted operations before state and Discord teardown, subject to the application's existing shutdown deadline. Removing the bot from a guild makes that guild's endpoint unavailable without deleting saved configuration.

## Validation

Run `npm run typecheck`, `npm test` and `npm run test:state`. MCP tests exercise real local HTTP without credentials, strict discovery metadata, two-guild isolation, Discord permissions, plugin management without execution, Quick Command revisions, secret redaction, DB interruption/recovery, cancellation and draining shutdown. Dashboard and Control API regression tests retain their authentication checks.
