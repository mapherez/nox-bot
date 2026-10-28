import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StateStore } from "../dist/core/state.js";
import { SqliteTransport, loadSqliteConfig } from "../dist/storage/sqlite.js";
import { PluginManager } from "../dist/plugins/manager.js";
import { builtInPlugins } from "../dist/plugins/catalog.js";
import { AuthService } from "../dist/core/auth.js";
import { DashboardServer } from "../dist/services/dashboard.js";
import { MessagingService } from "../dist/core/messaging.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { SecretVault } from "../dist/core/secrets.js";
import { sqliteFixture, untilSqlite } from "./fixtures/sqlite.mjs";
import { quietLogger, fakeOperations } from "./helpers.mjs";
quietLogger();
const command = (trigger, response = trigger) => ({
  guildId: "1",
  trigger,
  response,
  enabled: true,
});
test("SQLite creates its directory/schema automatically and persists across restart with private file permissions", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  assert.equal(f.state.writable, true);
  assert.equal(f.state.revision, "0");
  await f.state.put("quick", "1", "hello", command("hello", "Olá\n🙂"), "0");
  const revision = f.state.get("quick", "1", "hello").revision;
  assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  await f.state.close();
  const next = f.create();
  await next.state.start();
  assert.equal(next.state.get("quick", "1", "hello").data.response, "Olá\n🙂");
  assert.equal(next.state.get("quick", "1", "hello").revision, revision);
  assert.equal(next.state.get("quick", "2", "hello"), undefined);
  await next.state.close();
  const db = new DatabaseSync(f.filename, { readOnly: true });
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(
    db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  db.close();
});
test("SQLite checks all revisions atomically and never commits a partial transaction", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  await f.state.put(
    "quick",
    "1",
    "existing",
    command("existing", "Original"),
    "0",
  );
  const before = f.state.revision;
  await assert.rejects(
    f.state.commit([
      f.state.change("quick", "1", "new", command("new"), "0"),
      f.state.change(
        "quick",
        "1",
        "existing",
        command("existing", "Wrong"),
        "0",
      ),
    ]),
    { code: "STATE_CONFLICT" },
  );
  assert.equal(f.state.get("quick", "1", "new"), undefined);
  assert.equal(f.state.get("quick", "1", "existing").data.response, "Original");
  assert.equal(f.state.revision, before);
  await f.state.close();
  const next = f.create();
  await next.state.start();
  assert.equal(next.state.get("quick", "1", "new"), undefined);
});
test("real SQLite serializes concurrent writes and rejects stale expectations", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  const result = await Promise.allSettled([
    f.state.put("quick", "1", "same", command("same", "First"), "0"),
    f.state.put("quick", "1", "same", command("same", "Second"), "0"),
  ]);
  assert.equal(
    result.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    result.find((value) => value.status === "rejected").reason.code,
    "STATE_CONFLICT",
  );
  assert.equal(f.state.get("quick", "1", "same").data.response, "First");
});
test("complete JSON backups over 1000 commands commit atomically to SQLite and survive reopening", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  const quick = new QuickCommandService(f.state);
  const backup = Array.from({ length: 1001 }, (_, i) => ({
    trigger: `q${i}`,
    response: `Answer ${i}`,
    enabled: i % 2 === 0,
  }));
  await quick.import(
    "1",
    backup,
    Object.fromEntries(backup.map((row) => [row.trigger, "0"])),
  );
  assert.equal(new Set(quick.list("1").map((row) => row.revision)).size, 1);
  await f.state.close();
  const next = f.create();
  await next.state.start();
  const exported = new QuickCommandService(next.state).export("1");
  assert.equal(exported.length, 1001);
  assert.equal(exported.find((row) => row.trigger === "q1").enabled, false);
});
test("encrypted plugin secrets remain encrypted on disk and decrypt after SQLite restart", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  const vault = new SecretVault(Buffer.alloc(32, 1).toString("base64"));
  const plain = "fixture-secret-that-must-not-be-in-sqlite";
  const encrypted = vault.encrypt(plain, "1", "weather", "apiKey");
  await f.state.put(
    "plugin",
    "1",
    "weather",
    {
      guildId: "1",
      pluginId: "weather",
      enabled: false,
      settings: { units: "celsius", defaultLocation: "London" },
      secrets: { apiKey: encrypted },
    },
    "0",
  );
  await f.state.close();
  assert.equal(
    (await readFile(f.filename)).includes(Buffer.from(plain)),
    false,
  );
  const next = f.create();
  await next.state.start();
  assert.equal(
    vault.decrypt(
      next.state.get("plugin", "1", "weather").data.secrets.apiKey,
      "1",
      "weather",
      "apiKey",
    ),
    plain,
  );
});
test("unexpected SQLite worker exit recovers committed data without replaying writes", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  await f.state.put("quick", "1", "hello", command("hello"), "0");
  await f.transport.worker.terminate();
  assert.equal(f.state.writable, false);
  assert.equal(f.state.get("quick", "1", "hello").data.response, "hello");
  await assert.rejects(f.state.put("quick", "1", "new", command("new"), "0"), {
    code: "STATE_UNAVAILABLE",
  });
  await untilSqlite(() => f.state.writable);
  assert.equal(f.state.get("quick", "1", "hello").data.response, "hello");
  assert.equal(f.state.get("quick", "1", "new"), undefined);
});
test("a projection failure after SQL COMMIT reports uncertainty and recovery reads the durable result", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  const publish = f.transport.callbacks.snapshot;
  let fail = true;
  f.transport.callbacks.snapshot = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error("Fixture projection failure");
    }
    return publish(...args);
  };
  await assert.rejects(
    f.state.put("quick", "1", "saved", command("saved"), "0"),
    { code: "WRITE_UNCONFIRMED" },
  );
  assert.equal(f.state.get("quick", "1", "saved"), undefined);
  await untilSqlite(() => f.state.writable);
  assert.equal(f.state.get("quick", "1", "saved").data.response, "saved");
  assert.equal(f.state.revision, "1");
});
test("SQLite recovery does not silently create an empty database if its persistent file disappears", async (t) => {
  const f = await sqliteFixture(t, 30);
  await f.state.start();
  await f.state.put("quick", "1", "keep", command("keep"), "0");
  await f.transport.worker.terminate();
  await rm(f.filename, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.state.writable, false);
  assert.equal(f.state.get("quick", "1", "keep").data.response, "keep");
  await assert.rejects(stat(f.filename));
});
test("SQLite fails clearly on corrupt files, unavailable directories and foreign schemas without resetting data", async (t) => {
  const f = await sqliteFixture(t);
  const invalid = join(f.directory, "corrupt.sqlite");
  await writeFile(invalid, "not a SQLite database");
  const broken = new StateStore(new SqliteTransport({ filename: invalid }));
  await assert.rejects(broken.start(), { code: "STATE_UNAVAILABLE" });
  await broken.close();
  assert.equal(await readFile(invalid, "utf8"), "not a SQLite database");
  const blocker = join(f.directory, "file");
  await writeFile(blocker, "fixture");
  const unavailable = new StateStore(
    new SqliteTransport({ filename: join(blocker, "state.sqlite") }),
  );
  await assert.rejects(unavailable.start(), { code: "STATE_UNAVAILABLE" });
  await unavailable.close();
  const other = join(f.directory, "foreign.sqlite");
  const db = new DatabaseSync(other);
  db.exec(
    "CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('keep');",
  );
  db.close();
  const foreign = new StateStore(new SqliteTransport({ filename: other }));
  await assert.rejects(foreign.start(), { code: "INVALID_STATE" });
  await foreign.close();
  const read = new DatabaseSync(other, { readOnly: true });
  assert.equal(read.prepare("SELECT value FROM important").get().value, "keep");
  read.close();
});
test("SQLite only acknowledges saved state after lifecycle projections finish", async (t) => {
  const f = await sqliteFixture(t);
  await f.state.start();
  let release,
    entered = false;
  f.beforeClose(() => release?.());
  f.state.addProjection(() => {
    entered = true;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  let settled = false;
  const pending = f.state
    .put("quick", "1", "pending", command("pending"), "0")
    .then(() => {
      settled = true;
    });
  await untilSqlite(() => entered);
  assert.equal(settled, false);
  assert.equal(f.state.writable, false);
  release();
  await pending;
  assert.equal(settled, true);
  assert.equal(f.state.writable, true);
});
test("SQLite deployment configuration has one local file setting and no service credentials", () => {
  assert.deepEqual(loadSqliteConfig({}), {
    filename: resolve("data/nox-bot.sqlite"),
  });
  assert.deepEqual(
    loadSqliteConfig({ NOX_BOT_DATABASE_PATH: ".tmp/custom folder/db.sqlite" }),
    { filename: resolve(".tmp/custom folder/db.sqlite") },
  );
  for (const value of ["", "  ", ":memory:", "bad\0path"])
    assert.throws(() => loadSqliteConfig({ NOX_BOT_DATABASE_PATH: value }));
});

test("real SQLite backs dashboard import/SSE and persists authenticated sessions across restart", async (t) => {
  const f = await sqliteFixture(t),
    config = {
      ownerId: "7",
      clientId: "9",
      clientSecret: "fixture",
      origin: "http://localhost",
      sessionSecret: Buffer.alloc(32, 3).toString("base64"),
    };
  const plugins = new PluginManager(
    f.state,
    new SecretVault(Buffer.alloc(32, 2).toString("base64")),
    builtInPlugins,
    () => new Set(["1"]),
  );
  f.beforeClose(() => plugins.close());
  await f.state.start();
  const oauth = {
    authorizeURL: (nonce) => `http://localhost?state=${nonce}`,
    identify: async () => ({ id: "7", username: "Owner", avatar: null }),
  };
  const auth = new AuthService(f.state, config, oauth);
  await auth.initializeOwner();
  const login = auth.beginLogin(),
    nonce = new URL(login.url).searchParams.get("state"),
    signed = await auth.completeLogin("code", nonce, nonce);
  const quick = new QuickCommandService(f.state);
  const server = new DashboardServer(
    { host: "127.0.0.1", port: 0, publicOrigin: config.origin },
    auth,
    f.state,
    fakeOperations(),
    plugins,
    quick,
    undefined,
    new MessagingService([]),
  );
  await server.start();
  f.beforeClose(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}/dashboard/api/guilds/1`;
  const headers = {
    Cookie: signed.cookie.split(";")[0],
    Origin: config.origin,
    "X-CSRF-Token": signed.session.csrf,
    "Content-Type": "application/json",
  };
  const cancel = new AbortController();
  f.beforeClose(() => cancel.abort());
  const stream = await fetch(`${base}/events`, {
      headers,
      signal: cancel.signal,
    }),
    reader = stream.body.getReader();
  await reader.read();
  const commands = [
    { trigger: "hello", response: "Restored", enabled: true },
    { trigger: "hidden", response: "Disabled", enabled: false },
  ];
  const response = await fetch(`${base}/quick-commands/import`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      commands,
      expectedRevisions: { hello: "0", hidden: "0" },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quickCommands.length, 2);
  let event = "";
  while (!event.includes('"trigger":"hidden"')) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    event += new TextDecoder().decode(chunk.value);
  }
  assert.match(event, /Restored/);
  assert.deepEqual(
    await (await fetch(`${base}/quick-commands/export`, { headers })).json(),
    commands,
  );
  cancel.abort();
  await reader.cancel().catch(() => {});
  await server.stop();
  await plugins.close();
  await f.state.close();
  const next = f.create();
  await next.state.start();
  const restoredAuth = new AuthService(next.state, config, oauth);
  assert.equal(
    restoredAuth.authenticate(headers.Cookie.split("=")[1]).userId,
    "7",
  );
  assert.deepEqual(new QuickCommandService(next.state).export("1"), commands);
});
