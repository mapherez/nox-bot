# NoX Bot validation

Local validation performed on 6 October 2026 with Node 24.21.0 and Docker Desktop. Discord, OAuth, Weather and Priberam responses use fixtures; the database, subscriptions, plugin workers and native Dictionary are real. No deployment `.env` was read or changed and no real Discord login or remote resource changes were performed.

## Executed checks

| Check | Result |
| --- | --- |
| Strict backend, React and DB module typechecks | Passed |
| `npm test` | 58 passed; the two opt-in DB cases run separately |
| `npm run test:state` | Both real self-hosted DB integration cases passed |
| Backend, frontend and TypeScript DB module builds | Passed |
| Official CLI binding generation | Passed; private tables excluded |
| Production dependency audit | No reported vulnerabilities |
| Local Docker builds for AMD64 and ARM64 | Passed; native `nodehun`, SDK and module included |
| Image smoke checks with Control API enabled/disabled | Passed on both architectures |
| Compose bootstrap and DB container recreation | Passed on both architectures; data, signing keys and service identity persisted |
| Service credential mounts | Only service credentials readable by UID 10001; publisher absent; credential file mode 0600 |
| Docker SIGTERM | API drained and Discord destroyed with exit code 0, within one second on both architectures |
| Branding and legacy runtime audit | Obsolete product names, loaders, global registrar and manual refresh removed |

ARM64 execution used Docker emulation on the development host. These checks establish image/runtime compatibility; they do not measure performance on physical ARM64 hardware.

The standalone CLI invoked through a Linux container over the Windows checkout cannot discover the Windows workspace's `tsc` launcher and reports that fact. Independent strict workspace typechecks pass. Docker builds provide a native Linux launcher, and the official module build/typecheck passes there without that warning.

The tests cover owner refusal, expired/replayed OAuth state, session hashing/rotation/expiry, Origin/CSRF, sanitized API/SSE, guild isolation, contextual encryption, CRUD conflicts, private interactions, public Quick Commands/input cleanup/pagination, catalog collisions and capability validation, shared workers, three bounded crash retries, recovery reset and forced teardown. A competing subscription update cannot confirm a rejected reducer; acknowledgement alone cannot expose unconfirmed state. A confirmation timeout blocks writes and requests a new snapshot without replay.

The real DB outage case verifies Weather, Dictionary with native accent correction and image attachments, User Info and Ping workers continue using confirmed settings. It also exercises cached sessions, Quick Commands, messaging, reconciliation, blocked mutations, uncertain writes, snapshot recovery and a cold process with no confirmed state. Anonymous clients cannot obtain private state or invoke service mutations.

## Browser checks

Two independent Chromium sessions exercised the same backend with fake Discord/OAuth and a real local SpacetimeDB. Desktop was 1440 × 1000; mobile was 390 × 844.

- Owner login, server selector and the three navigation pages.
- Right drawer on desktop and full-width mobile drawer, scrollable body and fixed footer.
- Keyboard Escape/discard confirmation, cancellation preserving drafts and focus returning to the invoking button.
- Real DB stop/start: both browsers displayed reconnecting/stale state, disabled saves, retained the open draft and recovered automatically.
- Saved Weather preferences arrived in the second browser through SSE. Servers kept independent settings and Quick Commands; the fresh server remained empty.
- Quick Command create/edit/delete; concurrent edits produced a revision conflict and kept the losing browser's draft.
- Mobile sign out is accessible. Reduced-motion styles disable drawer and switch animations.

Local screenshots are kept under ignored `output/playwright/`; they are review artifacts rather than application assets.

## Reproduce locally

```sh
npm ci
npm run typecheck
npm test
npm run test:state
npm run db:generate
docker buildx build --platform linux/amd64 --load -t nox-bot:validation-amd64 .
docker buildx build --platform linux/arm64 --load -t nox-bot:validation-arm64 .
node scripts/test-compose.mjs amd64
node scripts/test-compose.mjs arm64
```

The DB integration harness uses disposable containers and private ignored fixture credentials. The Compose harness uses an empty fixture environment and locally built images, starts only the database/initializer plus a subscription smoke process, and removes only its own project containers/volumes. Neither harness starts the production Discord bot or reads deployment credentials.

Image checks can mount `tests/` read-only and run `tests/fixtures/docker-smoke.mjs enabled` or `disabled`. `tests/docker-compose.smoke.yml` and `tests/fixtures/docker-shutdown.mjs` provide the offline shutdown fixture.

## Live acceptance — not executed

Fakes do not establish actual Discord OAuth or command registration state. Complete these checks separately in the configured deployment:

1. Register the exact HTTPS origin's `/auth/callback`, configure the owner ID/client secret and existing proxy, then verify successful owner login and refusal of a different Discord account. Check Secure/HttpOnly/SameSite cookies, state replay refusal, logout and expiry. No OAuth token should appear in browser storage or API responses.
2. Verify bot installation and Message Content intent in two test servers. Enable each built-in plugin and inspect the application's guild command registrations: `/weather`, `/definition`, `/userinfo`, `/ping`, plus Core `/nox help`, `/nox commands`, `/nox guildid`. Confirm this application's old global commands disappear and other applications are untouched.
3. Change only Weather settings and confirm no unnecessary registration writes. Rapidly toggle plugins and verify final guild registrations converge without duplicates. Remove/re-add the bot and confirm saved configuration is retained while an absent server does not keep workers alive.
4. Execute each command, Weather refresh and stale/disabled components. Confirm plugin replies/errors/defer/follow-ups stay private, while Quick Command selections send publicly and failed input deletion does not prevent delivery. Verify actual Priberam attachments and accent correction.
5. Stop only SpacetimeDB after initialization. Confirm live commands, messaging, help and existing sessions keep working; configuration writes/new logins are refused; `/health` distinguishes functional readiness from degraded synchronization. Restart the DB and verify snapshot recovery before saves reopen. Restart the whole application while the DB is down and confirm it waits for state.
6. Exercise two browsers through the actual proxy, including long-lived SSE, mobile keyboard/focus, preserved drafts, conflicts, server-specific secrets and explicit secret replacement/removal. Confirm Control API bearer/permissions and deployment shutdown.

External setup remains manual: configure Discord Developer Portal branding and register the OAuth callback. No workflow was executed, no image was published, and no release/tag or remote configuration was created.

## Official references

- [SpacetimeDB modules](https://spacetimedb.com/docs/databases/), [subscriptions](https://spacetimedb.com/docs/clients/subscriptions/) and [identity-controlled views](https://spacetimedb.com/docs/functions/views/).
- [Discord OAuth](https://docs.discord.com/developers/topics/oauth2), [interaction responses](https://docs.discord.com/developers/interactions/receiving-and-responding) and [application commands](https://docs.discord.com/developers/interactions/application-commands).
