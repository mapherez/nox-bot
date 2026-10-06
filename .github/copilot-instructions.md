# NoX Bot repository guidance

Use Node 24 and strict TypeScript. Backend ESM imports use explicit `.js` extensions.

- `src/services/runtime.ts` composes one Discord client, storage projection, plugin supervisor, reconciler, dashboard and optional Control API.
- `src/core/state.ts` holds only subscription-confirmed state. DB disconnection preserves the last confirmed runtime and blocks persistent mutations/new sessions. Never add optimistic runtime state, a write queue or file fallback.
- `spacetimedb/src/index.ts` uses private tables, service-identity views and guarded reducers. Keep server/CLI/SDK pinned together and regenerate bindings with `npm run db:generate`.
- `src/plugins/catalog.ts` is the built-in catalog. Each plugin owns typed runtime handlers/lifecycle and a lazy React panel in `web/src/plugins/`. Validate definitions and capabilities before activation; use one isolated child process per plugin shared across enabled guilds.
- `src/core/commandRegistry.ts` supplies top-level plugin commands and Core `/nox` help/commands/guildid. `src/services/commandReconciler.ts` owns incremental guild registrations. Do not restore global runtime registrations, file loaders or manual refresh commands.
- `src/core/quickCommands.ts` stores guild-scoped Quick Commands. Input cleanup failure must not prevent the public response. Plugin interactions and follow-ups stay ephemeral; interactive context is owner/guild/plugin/expiry bound.
- `src/core/auth.ts` is owner-only Discord OAuth with hashed server-side sessions, Origin/CSRF checks and HttpOnly cookies. Never expose deployment keys, OAuth tokens or plugin secrets in browser bundles, API/SSE reads or logs.
- `web/` is an English React/Vite dashboard using CSS Modules and native modal dialogs. Preserve drafts across sync interruptions/conflicts and confirm discarded changes.
- Control API `/v1` remains opt-in with its existing bearer, payload, permission and error contracts; use the same Discord services.

Run `npm run typecheck`, `npm test`, `npm run build:web`, `npm run test:state` and local Docker builds for both architectures as appropriate. Live Discord/OAuth acceptance is separate from fakes. Do not edit `.env`, publish images, run release workflows, create tags/releases or alter remote resources during local implementation.
