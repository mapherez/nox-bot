import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { SecretVault } from "../dist/core/secrets.js";
import { PluginManager } from "../dist/plugins/manager.js";
import { builtInPlugins } from "../dist/plugins/catalog.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { CommandRegistry } from "../dist/core/commandRegistry.js";
import { CommandReconciler } from "../dist/services/commandReconciler.js";
import { MessagingService } from "../dist/core/messaging.js";
import { AuthService } from "../dist/core/auth.js";
import { sqliteFixture, untilSqlite } from "./fixtures/sqlite.mjs";
import { quietLogger } from "./helpers.mjs";
quietLogger();
test(
  "real SQLite worker recovery preserves text workers, sessions, Quick Commands and reconciliation without a DB server",
  { timeout: 30000 },
  async (t) => {
    const f = await sqliteFixture(t, 30),
      { state, transport } = f,
      guildId = "987654321";
    const launcher = (entry, args, options) =>
      fork(entry, args, {
        ...options,
        execArgv: [
          `--import=${new URL("./fixtures/worker-fetch.mjs", import.meta.url).href}`,
        ],
      });
    const plugins = new PluginManager(
      state,
      new SecretVault(randomBytes(32).toString("base64")),
      builtInPlugins,
      () => new Set([guildId]),
      launcher,
    );
    f.beforeClose(() => plugins.close());
    await state.start();
    await plugins.configure("weather", guildId, {
      settings: { units: "celsius", defaultLocation: "London" },
      secrets: { apiKey: "fixture-key" },
      expectedRevision: "0",
    });
    const workers = builtInPlugins.filter(
      (plugin) => !plugin.capabilities.includes("voice"),
    );
    for (const plugin of workers)
      await plugins.setEnabled(
        plugin.id,
        guildId,
        true,
        plugins.configuration(plugin.id, guildId).revision,
      );
    const pids = Object.fromEntries(
      workers.map((plugin) => [
        plugin.id,
        plugins.runtimeStatus(plugin.id).pid,
      ]),
    );
    const quick = new QuickCommandService(state);
    await quick.save(
      guildId,
      { guildId, trigger: "hello", response: "Public response", enabled: true },
      "0",
    );
    const auth = new AuthService(
      state,
      {
        ownerId: "7",
        clientId: "9",
        clientSecret: "fixture",
        origin: "http://localhost",
        sessionSecret: randomBytes(32).toString("base64"),
      },
      {
        authorizeURL: (state) => `http://localhost?state=${state}`,
        identify: async () => ({ id: "7", username: "Owner", avatar: null }),
      },
    );
    await auth.initializeOwner();
    const login = auth.beginLogin(),
      nonce = new URL(login.url).searchParams.get("state");
    const signed = await auth.completeLogin("code", nonce, nonce),
      token = signed.cookie.split(";")[0].split("=")[1];
    let hold = true,
      release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    state.addProjection(async () => {
      if (hold) await gate;
    });
    f.beforeClose(() => {
      hold = false;
      release();
    });
    await transport.worker.terminate();
    assert.equal(state.writable, false);
    assert.equal(state.initialized, true);
    assert.equal(quick.response(guildId, "hello"), "Public response");
    assert.equal(auth.authenticate(token).userId, "7");
    assert.equal(plugins.configuration("voice", guildId).enabled, false);
    assert.throws(() => auth.beginLogin(), { code: "STATE_UNAVAILABLE" });
    await assert.rejects(
      quick.delete(guildId, "hello", quick.list(guildId)[0].revision),
      { code: "STATE_UNAVAILABLE" },
    );
    const context = {
      guildId,
      user: {
        id: "7",
        username: "Tester",
        avatarURL: "https://example.com/avatar.png",
        createdTimestamp: 100,
        joinedTimestamp: 200,
        roles: [],
      },
      options: {},
      users: {},
      latencyMs: 42,
      command: "",
    };
    const results = {};
    for (const plugin of workers)
      results[plugin.id] = await plugins.execute(
        plugin.id,
        plugin.commands[0].handler,
        {
          ...context,
          command: plugin.commands[0].name,
          options: plugin.id === "dictionary" ? { word: "coracao" } : {},
        },
      );
    assert.match(results.weather.embeds[0].title, /London/);
    assert.equal(results.dictionary.attachments.length, 1);
    assert.match(results.ping.content, /Pong/);
    assert.ok(results.userinfo.embeds.length);
    for (const plugin of workers)
      assert.equal(plugins.runtimeStatus(plugin.id).pid, pids[plugin.id]);
    const sent = [],
      messaging = new MessagingService([
        {
          provider: "discord",
          send: async (target, rich) => {
            sent.push(rich.content);
            return {
              provider: "discord",
              messageId: "8",
              channelId: target.channelId,
              guildId,
            };
          },
        },
      ]);
    await messaging.send(
      { provider: "discord", kind: "guild-channel", guildId, channelId: "9" },
      { content: quick.response(guildId, "hello") },
    );
    assert.deepEqual(sent, ["Public response"]);
    const actual = [],
      registry = new CommandRegistry(plugins);
    let writes = 0;
    const reconciler = new CommandReconciler("9", registry, {
      get: async () => actual,
      post: async (_route, { body }) =>
        actual.push({ ...body, id: String(++writes) }),
      patch: async () => {
        writes++;
      },
      delete: async () => {
        writes++;
      },
    });
    await reconciler.reconcile(guildId);
    assert.equal(
      actual.length,
      1 + workers.reduce((count, plugin) => count + plugin.commands.length, 0),
    );
    const count = writes;
    await reconciler.reconcile(guildId);
    assert.equal(writes, count);
    await reconciler.close();
    // A fresh process can open the same durable file without waiting for another DB container.
    const cold = f.create();
    await cold.state.start();
    assert.equal(
      cold.state.get("quick", guildId, "hello").data.response,
      "Public response",
    );
    await cold.state.close();
    hold = false;
    release();
    await untilSqlite(() => state.writable);
    for (const plugin of workers)
      assert.equal(plugins.runtimeStatus(plugin.id).pid, pids[plugin.id]);
    assert.equal(plugins.configuration("voice", guildId).enabled, false);
    assert.equal(auth.authenticate(token).userId, "7");
  },
);
