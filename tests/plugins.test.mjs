import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { StateStore } from "../dist/core/state.js";
import { SecretVault } from "../dist/core/secrets.js";
import { PluginManager } from "../dist/plugins/manager.js";
import { builtInPlugins } from "../dist/plugins/catalog.js";
import { CommandRegistry } from "../dist/core/commandRegistry.js";
import { CommandReconciler } from "../dist/services/commandReconciler.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { AuthService } from "../dist/core/auth.js";

async function fixture(t) {
  let callbacks;
  const rows = new Map();
  let sequence = 0n;
  const transport = {
    connect: async (cb) => {
      callbacks = cb;
      await cb.snapshot([], 0n, 1);
    },
    mutate: async (changes) => {
      for (const c of changes)
        if ((rows.get(c.key)?.revision ?? 0n) !== c.expectedRevision)
          throw Object.assign(new Error("Conflict"), {
            code: "STATE_CONFLICT",
          });
      sequence++;
      for (const c of changes)
        c.value === null
          ? rows.delete(c.key)
          : rows.set(c.key, { ...c, revision: sequence });
      await callbacks.snapshot([...rows.values()], sequence, 1);
    },
    close: async () => {},
  };
  const state = new StateStore(transport),
    vault = new SecretVault(randomBytes(32).toString("base64"));
  const manager = new PluginManager(
    state,
    vault,
    builtInPlugins,
    () => new Set(["1", "2"]),
  );
  t.after(async () => {
    await manager.close();
    await state.close();
  });
  await state.start();
  return { state, manager, vault, disconnect: () => callbacks.disconnected() };
}
test("plugin process starts lazily, serves two guilds, survives DB loss and exits after the last disable", async (t) => {
  const f = await fixture(t),
    registry = new CommandRegistry(f.manager);
  assert.equal(f.manager.runtimeStatus("ping").pid, undefined);
  assert.deepEqual(
    registry.desired("1").map((c) => c.name),
    ["nox"],
  );
  await f.manager.setEnabled("ping", "1", true, "0");
  const pid = f.manager.runtimeStatus("ping").pid;
  assert.equal(typeof pid, "number");
  assert.deepEqual(
    registry.desired("1").map((c) => c.name),
    ["nox", "ping"],
  );
  assert.deepEqual(
    registry.desired("2").map((c) => c.name),
    ["nox"],
  );
  await f.manager.setEnabled("ping", "2", true, "0");
  assert.equal(f.manager.runtimeStatus("ping").pid, pid);
  const context = {
    guildId: "1",
    command: "ping",
    options: {},
    users: {},
    latencyMs: 42,
    user: {
      id: "3",
      username: "Tester",
      avatarURL: "https://example.com/avatar.png",
      createdTimestamp: 0,
      joinedTimestamp: null,
      roles: [],
    },
  };
  assert.equal(
    (await f.manager.execute("ping", "ping", context)).content,
    "🏓 Pong! Latency: 42ms",
  );
  await f.manager.setEnabled(
    "ping",
    "1",
    false,
    f.state.get("plugin", "1", "ping").revision,
  );
  assert.equal(f.manager.runtimeStatus("ping").pid, pid);
  await assert.rejects(f.manager.execute("ping", "ping", context));
  await f.manager.setEnabled(
    "ping",
    "2",
    false,
    f.state.get("plugin", "2", "ping").revision,
  );
  assert.equal(f.manager.runtimeStatus("ping").pid, undefined);
  assert.throws(() => process.kill(pid, 0));
  await f.manager.setEnabled(
    "ping",
    "1",
    true,
    f.state.get("plugin", "1", "ping").revision,
  );
  f.disconnect();
  assert.equal(
    (await f.manager.execute("ping", "ping", context)).content,
    "🏓 Pong! Latency: 42ms",
  );
  await assert.rejects(
    f.manager.setEnabled(
      "ping",
      "1",
      false,
      f.state.get("plugin", "1", "ping").revision,
    ),
    { code: "STATE_UNAVAILABLE" },
  );
});
test("settings and secrets are separate per guild and browser configuration never includes plaintext or ciphertext", async (t) => {
  const f = await fixture(t);
  await f.manager.configure("weather", "1", {
    settings: { units: "celsius", defaultLocation: "Lisbon" },
    secrets: { apiKey: "test-key-private" },
    expectedRevision: "0",
  });
  await f.manager.configure("weather", "2", {
    settings: { units: "fahrenheit", defaultLocation: "London" },
    expectedRevision: "0",
  });
  const one = f.manager.configuration("weather", "1"),
    two = f.manager.configuration("weather", "2");
  assert.equal(one.secrets.apiKey.configured, true);
  assert.equal(two.secrets.apiKey.configured, false);
  assert.equal(one.settings.defaultLocation, "Lisbon");
  assert.equal(two.settings.units, "fahrenheit");
  assert.equal(JSON.stringify(one).includes("test-key-private"), false);
  assert.equal(JSON.stringify(one).includes("aes256gcm"), false);
  await assert.rejects(
    f.manager.setEnabled("weather", "2", true, two.revision),
  );
  assert.throws(
    () =>
      new PluginManager(
        f.state,
        f.vault,
        [
          builtInPlugins[0],
          { ...builtInPlugins[1], commands: builtInPlugins[0].commands },
        ],
        () => new Set(),
      ),
  );
});
test("reconciliation creates, updates and deletes incrementally, then performs no writes when converged", async () => {
  let actual = [
    { id: "8", name: "nox", type: 1, description: "old", options: [] },
    { id: "9", name: "legacy", type: 1, description: "stale" },
  ];
  const writes = [],
    desired = [
      { name: "nox", description: "new" },
      { name: "weather", description: "weather" },
    ];
  const rest = {
    get: async () => structuredClone(actual),
    post: async (route, { body }) => {
      writes.push("create");
      actual.push({ ...body, id: "10" });
    },
    patch: async (route, { body }) => {
      writes.push("update");
      actual = actual.map((c) =>
        c.id === route.split("/").at(-1) ? { ...body, id: c.id } : c,
      );
    },
    delete: async (route) => {
      writes.push("delete");
      actual = actual.filter((c) => c.id !== route.split("/").at(-1));
    },
  };
  const reconciler = new CommandReconciler(
    "7",
    { desired: () => desired },
    rest,
  );
  await reconciler.reconcile("1");
  assert.deepEqual(writes, ["delete", "update", "create"]);
  writes.length = 0;
  await reconciler.reconcile("1");
  assert.deepEqual(writes, []);
  await reconciler.cleanGlobalRegistrations();
  assert.equal(actual.length, 0);
  await reconciler.close();
});
test("Quick Command CRUD updates immediately and rejects cross-guild writes", async (t) => {
  const { state } = await fixture(t),
    quick = new QuickCommandService(state);
  await quick.save(
    "1",
    { guildId: "1", trigger: "HELLO", response: "first", enabled: true },
    "0",
  );
  assert.equal(quick.response("1", "hello"), "first");
  assert.equal(quick.response("2", "hello"), undefined);
  await quick.save(
    "1",
    { guildId: "1", trigger: "hello", response: "second", enabled: true },
    quick.list("1")[0].revision,
  );
  assert.equal(quick.response("1", "hello"), "second");
  await assert.rejects(
    quick.save(
      "2",
      { guildId: "1", trigger: "hello", response: "wrong", enabled: true },
      "0",
    ),
  );
  await quick.delete("1", "hello", quick.list("1")[0].revision);
  assert.equal(quick.response("1", "hello"), undefined);
});
test("OAuth admits only the owner, rejects state replay, persists hashed sessions and checks CSRF and expiry offline", async (t) => {
  const f = await fixture(t);
  let identity = { id: "7", username: "Owner", avatar: null },
    clock = 1000000;
  const auth = new AuthService(
    f.state,
    {
      clientId: "9",
      clientSecret: "secret",
      ownerId: "7",
      origin: "https://bot.example.com",
      sessionSecret: randomBytes(32).toString("base64"),
    },
    {
      authorizeURL: (state) =>
        `https://discord.example/authorize?state=${state}`,
      identify: async () => identity,
    },
    () => clock,
  );
  await auth.initializeOwner();
  let login = auth.beginLogin(),
    state = new URL(login.url).searchParams.get("state");
  const result = await auth.completeLogin("code", state, state);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /Secure/);
  assert.match(result.cookie, /SameSite=Lax/);
  const token = result.cookie.split(";")[0].split("=")[1];
  assert.equal(JSON.stringify(f.state.list("session")).includes(token), false);
  assert.equal(auth.authenticate(token).userId, "7");
  await assert.rejects(auth.completeLogin("code", state, state), {
    code: "OAUTH_STATE_INVALID",
  });
  assert.throws(
    () =>
      auth.validateMutation(
        result.session,
        "https://evil.example",
        result.session.csrf,
      ),
    { code: "CSRF_INVALID" },
  );
  assert.throws(
    () =>
      auth.validateMutation(result.session, "https://bot.example.com", "wrong"),
    { code: "CSRF_INVALID" },
  );
  auth.validateMutation(
    result.session,
    "https://bot.example.com",
    result.session.csrf,
  );
  identity = { id: "8", username: "Visitor", avatar: null };
  login = auth.beginLogin();
  state = new URL(login.url).searchParams.get("state");
  await assert.rejects(auth.completeLogin("code", state, state), {
    code: "ACCESS_DENIED",
  });
  f.disconnect();
  assert.equal(auth.authenticate(token).userId, "7");
  assert.throws(() => auth.beginLogin(), { code: "STATE_UNAVAILABLE" });
  clock += 3600001;
  assert.throws(() => auth.authenticate(token), { code: "SESSION_EXPIRED" });
});
test("logout waits for an in-flight session activity refresh and still invalidates the session", async (t) => {
  const f = await fixture(t);
  let clock = 1000000;
  const auth = new AuthService(
    f.state,
    {
      clientId: "9",
      clientSecret: "fixture",
      ownerId: "7",
      origin: "http://localhost",
      sessionSecret: randomBytes(32).toString("base64"),
    },
    {
      authorizeURL: (state) => `https://discord.example?state=${state}`,
      identify: async () => ({ id: "7", username: "Owner", avatar: null }),
    },
    () => clock,
  );
  await auth.initializeOwner();
  const login = auth.beginLogin(),
    state = new URL(login.url).searchParams.get("state");
  const signed = await auth.completeLogin("code", state, state);
  const token = signed.cookie.split(";")[0].split("=")[1];
  clock += 6 * 60 * 1000;
  const session = auth.authenticate(token);
  const cookie = await auth.logout(token, session);
  assert.match(cookie, /Max-Age=0/);
  assert.equal(f.state.get("session", "", session.hash), undefined);
  assert.throws(() => auth.authenticate(token), { code: "SESSION_EXPIRED" });
});
