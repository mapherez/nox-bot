import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { StateStore } from "../../dist/core/state.js";
import {
  SqliteTransport,
  loadSqliteConfig,
} from "../../dist/storage/sqlite.js";
// Production image and real named volume only; no Discord login or deployment credentials.
assert.equal(process.getuid(), 10001);
const config = loadSqliteConfig(process.env),
  state = new StateStore(new SqliteTransport(config));
try {
  await state.start();
  if (process.argv[2] === "write")
    await state.put(
      "guild",
      "101",
      "",
      { guildId: "101", name: "Persistent fixture" },
      "0",
    );
  assert.equal(state.get("guild", "101").data.name, "Persistent fixture");
  assert.equal(state.writable, true);
  const file = await stat(config.filename);
  assert.equal(file.uid, 10001);
  assert.equal(file.mode & 0o777, 0o600);
  console.log(
    `SQLite automatic initialization and named-volume persistence passed (${process.arch}, ${process.argv[2]}).`,
  );
} finally {
  await state.close();
}
