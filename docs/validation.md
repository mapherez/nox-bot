# NoX Bot validation

The default suite uses fake Discord/OAuth/HTTP providers and real local SQLite files. It creates disposable databases under the repo's ignored `.tmp/` directory, never reads deployment `.env`, never logs into Discord, and never mounts production data. No external database server or Docker installation is needed for the SQLite tests.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run test:state
```

Use Node 24.22.1 or newer within Node 24. `npm test` builds the backend/dashboard and runs all ordinary tests, including real SQLite integration. `test:state` is a convenience command for the SQLite/storage-availability subset, not an opt-in external-server harness.

Storage coverage includes automatic schema/directory creation, file permissions, restart persistence, namespace isolation, atomic rollback, concurrent revision conflicts, complete JSON backup restoration, encrypted plugin secrets, corrupt/foreign schemas, unavailable paths, worker exit/recovery and committed-but-unconfirmed results. The availability case exercises real text-plugin workers, native Dictionary assets, cached sessions, Quick Commands, messaging and command reconciliation during a storage-worker interruption. Voice's explicit activation policy remains covered by its own tests.

Dashboard/Control API/MCP tests cover authorization, Origin/CSRF, session renewal, secret redaction, server boundaries, revisions, SSE and shutdown. SQLite failures do not introduce an alternative persistence backend or automatically replay failed writes.

## Production image and volume checks

CI builds the production image on AMD64 and ARM64 and verifies native Dictionary, Opus/DAVE and built-in SQLite loading. The Compose harness initializes a fresh named volume as UID/GID 10001, writes committed data, recreates the application container and confirms persistence. It uses an empty fixture environment, a unique Compose project and locally built images; it removes only its own test containers/volumes.

To reproduce when Docker is available:

```sh
docker buildx build --platform linux/amd64 --load -t nox-bot:validation-amd64 .
node scripts/test-compose.mjs amd64
docker buildx build --platform linux/arm64 --load -t nox-bot:validation-arm64 .
node scripts/test-compose.mjs arm64
```

Container checks configured in CI are not evidence that they were executed locally. The implementation report distinguishes executed local checks from pending container builds. The manual publishing workflow runs the checks before publishing; local validation does not start that workflow or change remote image visibility.

## Live acceptance

Fakes do not establish the state of a real Discord deployment. After rollout:

1. Verify owner OAuth login, refusal of another account, cookie/CSRF behaviour and logout.
2. Import the saved Quick Commands JSON in the chosen server, confirm disabled entries and responses, then restart the container and verify persistence.
3. Reconfigure the text plugins and their secrets, verify guild slash commands and public Quick Commands, and confirm server isolation.
4. Open two dashboard sessions. Verify SSE updates and revision conflicts without lost drafts.
5. Check Control API/MCP behaviour through the existing proxy and bounded shutdown.
6. If using NoX Voice, manually enable it in the chosen channel, test conversation/interruptions and text commands together, then verify a bot restart leaves voice disabled.

## References

- [Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).
- [SQLite WAL](https://sqlite.org/wal.html) and [transactions](https://sqlite.org/lang_transaction.html).
- [Discord OAuth](https://docs.discord.com/developers/topics/oauth2) and [application commands](https://docs.discord.com/developers/interactions/application-commands).
