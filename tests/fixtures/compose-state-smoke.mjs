import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { StateStore } from "../../dist/core/state.js";
import { SpacetimeTransport } from "../../dist/storage/spacetime.js";

// A real service subscription in the production image; no Discord login or deployment .env.
const path = process.env.NOX_BOT_STATE_CREDENTIAL_FILE;
const credentials = JSON.parse(await readFile(path, "utf8"));
assert.deepEqual(Object.keys(credentials), ["service"]);
assert.equal((await stat(path)).uid, 10001);
assert.equal((await stat(path)).mode & 0o777, 0o600);
await assert.rejects(readFile("/run/nox-bot/publisher/credentials.json"));
const state = new StateStore(
  new SpacetimeTransport({
    url: process.env.NOX_BOT_SPACETIMEDB_URL,
    database: process.env.NOX_BOT_SPACETIMEDB_DATABASE,
    token: credentials.service.token,
  }),
);
const deadline = setTimeout(() => {
  console.error("Compose state subscription timed out.");
  process.exit(1);
}, 30000);
try {
  await state.start();
  if (process.argv[2] === "write") {
    await state.put(
      "guild",
      "101",
      "",
      { guildId: "101", name: "Persistent fixture" },
      "0",
    );
  }
  assert.equal(state.get("guild", "101").data.name, "Persistent fixture");
  assert.equal(state.writable, true);
  console.log(
    `Compose service identity, private mounts and persistent snapshot verified (${process.arch}).`,
  );
} finally {
  clearTimeout(deadline);
  await state.close();
}
