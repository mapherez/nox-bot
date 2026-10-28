# SQLite transition report

## What changed

- SQLite is the sole persistent backend, using Node's built-in SQLite in a dedicated worker thread.
- The application automatically creates its schema and file. Committed transactions still drive the existing plugin lifecycle, revision checks and dashboard SSE.
- The deployment now has one application container and one named data volume. SQLite stores Quick Commands, plugin settings, encrypted plugin secrets, owner authorization, dashboard sessions and legacy import markers.
- Quick Command JSON exports remain portable. Imports now use one atomic transaction for the entire validated file.
- The external DB adapter, generated bindings, DB module/workspace, provisioning and credential scripts, special database image/allocator recipe and its image-publication workflow have been removed.
- The old DB-specific tests have been replaced with real SQLite tests that run on every normal test execution. Image/volume smoke tests cover AMD64 and ARM64 in CI.
- Node 24.22.1 or newer within Node 24 is required; the Docker image includes it. No separate SQLite npm package or service is installed.

## Environment variables

Add, or retain the documented default:

```dotenv
NOX_BOT_DATABASE_PATH=./data/nox-bot.sqlite
```

This is an application/container file path. With the image working directory `/app`, it resolves to `/app/data/nox-bot.sqlite`. The Compose `bot-data:/app/data` mount persists that directory. Do not point this at an old database volume or at a file outside the persistent mount.

Remove these obsolete variables **if present** in the deployment environment, Compose overrides or CI configuration:

| Removed variable | Former purpose |
| --- | --- |
| `NOX_BOT_SPACETIMEDB_URL` | External database connection |
| `NOX_BOT_SPACETIMEDB_DATABASE` | External database name |
| `NOX_BOT_SPACETIMEDB_TOKEN` | Database service identity |
| `NOX_BOT_STATE_CREDENTIAL_FILE` | Publisher/service credential file |
| `NOX_BOT_SERVICE_CREDENTIAL_FILE` | Provisioned application credential output |
| `NOX_BOT_STATE_BUNDLE` | Published database module |
| `NOX_BOT_SPACETIMEDB_IMAGE` | Custom database/toolchain image |

The old test-only `NOX_BOT_TEST_STATE_*` settings are also removed. `db:build` and `db:generate` no longer exist; `test:state` now runs local SQLite integration tests.

Keep the Discord, OAuth, owner, public URL, dashboard host/port, image tag/version, encryption/session keys, optional Control API and `NOX_VOICE_*` variables. This migration does not replace their values or alter the external voice service.

## Compose changes

Use the updated `docker-compose.yml` as the base for the deployed configuration. It keeps the `nox-bot` service, image, dashboard publication, restart policy, healthcheck and shutdown grace period.

Removed services:

- `spacetimedb`
- `state-init`
- `state-volume-init`

Removed volume declarations/mounts:

- `spacetime-data`
- `spacetime-signing`
- `state-publisher`
- `state-service`

The private `state` network and dependencies on database initialization are removed. Add the new persistent mount and declaration:

```yaml
services:
  nox-bot:
    volumes:
      - bot-data:/app/data

volumes:
  bot-data:
```

The standard named volume needs no host directory, permission-fixing command or root initializer. The image prepares `/app/data` for UID/GID 10001. A custom host bind mount needs its own preconfigured read/write permissions.

## Apply to the deployment

1. Keep the exported Quick Commands JSON outside the old DB volumes. Keep the existing deployment secrets and environment values you intend to reuse.
2. Build/publish the updated bot image using the existing bot image workflow. Update the deployed Compose base and `.env` as above, retaining optional overrides and the existing Compose project name.
3. Pull and recreate the bot. For this transition, remove the former services belonging to that Compose project:

   ```sh
   docker compose pull nox-bot
   docker compose up -d --remove-orphans
   ```

4. Open the dashboard and log in. SQLite starts empty: choose the Discord server and use **Quick Commands → ⋮ → Import commands** to restore the JSON.
5. Reconfigure/re-enable the plugins and re-enter any plugin-specific secrets. Voice remains manually activated; choose/save its channel again. Existing external certificates and voice-service settings are unaffected.
6. Verify the commands and a normal container restart. Routine operation remains `docker compose up -d`.

`--remove-orphans` removes old service containers in the same Compose project. It does not delete their old named volumes. Those historical volumes and the retired database image may be removed manually through the deployment host's Docker tooling after the restored setup is verified. No deployed files, running containers, old volumes or GitHub packages were modified by the repository migration.

The new `bot-data` volume must survive updates. A full-application backup should include that volume while the bot is stopped, plus the external encryption/session keys. Quick Command JSON alone intentionally excludes plugin secrets/configuration and login sessions.

## Validation performed for this change

- Strict backend and dashboard typechecks passed with Node 24.22.1.
- Backend/dashboard production builds passed.
- The full suite passed **114 tests**, with no skipped tests. It includes real SQLite files, HTTP/SSE, session persistence, rollback, worker recovery and the existing voice/text regression cases.
- Base Compose, voice override, Control API override and both overrides together passed configuration checks using an isolated fixture environment; the real deployment `.env` was not loaded.
- The official `node:24.22.1-bookworm-slim` tag was verified to include Linux AMD64 and ARM64 images.
- Local Docker image/volume execution was not performed because the default Docker daemon was unavailable. Both architecture checks are configured in the updated Actions workflow and must pass before image publication.
- npm still reports the three previously identified high-severity dependency alerts (`@modelcontextprotocol/node`, `undici`, `zod`); resolving those independent dependencies was outside this storage transition.
