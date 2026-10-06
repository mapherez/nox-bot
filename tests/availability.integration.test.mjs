import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { provisionState } from "../scripts/provision-state.mjs";
import { StateStore } from "../dist/core/state.js";
import { SpacetimeTransport } from "../dist/storage/spacetime.js";
import { SecretVault } from "../dist/core/secrets.js";
import { PluginManager } from "../dist/plugins/manager.js";
import { builtInPlugins } from "../dist/plugins/catalog.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { CommandRegistry } from "../dist/core/commandRegistry.js";
import { CommandReconciler } from "../dist/services/commandReconciler.js";
import { MessagingService } from "../dist/core/messaging.js";
import { AuthService } from "../dist/core/auth.js";
const url = process.env.NOX_BOT_TEST_STATE_URL,
  container = process.env.NOX_BOT_TEST_STATE_CONTAINER;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Integration condition timed out.");
    await delay(20);
  }
}
test(
  "real DB outage preserves all workers, Quick Commands, sessions, messaging and reconciliation; cold start awaits recovery",
  { skip: !url || !container, timeout: 60000 },
  async (t) => {
    if (!/^nox-bot-test-[a-f0-9]{8}$/.test(container))
      throw new Error("Only a disposable test container may be interrupted.");
    const database =
        process.env.NOX_BOT_TEST_STATE_DATABASE ?? "nox-bot-integration",
      credentialFile = process.env.NOX_BOT_TEST_STATE_CREDENTIAL_FILE;
    const { token } = await provisionState({
      url,
      database,
      credentialFile,
      bundle: "spacetimedb/dist/bundle.js",
    });
    const transport = new SpacetimeTransport({ url, database, token }),
      state = new StateStore(transport),
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
    t.after(async () => {
      await plugins.close();
      await state.close();
    });
    await state.start();
    await plugins.configure("weather", guildId, {
      settings: { units: "celsius", defaultLocation: "London" },
      secrets: { apiKey: "fixture-key" },
      expectedRevision: "0",
    });
    for (const plugin of builtInPlugins)
      await plugins.setEnabled(
        plugin.id,
        guildId,
        true,
        plugins.configuration(plugin.id, guildId).revision,
      );
    for (const plugin of builtInPlugins)
      assert.equal(
        plugins.isActive(plugin.id, guildId),
        true,
        `${plugin.id}: ${JSON.stringify(plugins.runtimeStatus(plugin.id))}`,
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
      nonce = new URL(login.url).searchParams.get("state"),
      signed = await auth.completeLogin("code", nonce, nonce),
      sessionToken = signed.cookie.split(";")[0].split("=")[1];
    const pids = Object.fromEntries(
      builtInPlugins.map((plugin) => [
        plugin.id,
        plugins.runtimeStatus(plugin.id).pid,
      ]),
    );
    const stop = () =>
        execFileSync("docker", ["stop", "-t", "1", container], {
          stdio: "ignore",
        }),
      start = () =>
        execFileSync("docker", ["start", container], { stdio: "ignore" });
    t.after(() => {
      try {
        start();
      } catch {}
    });
    stop();
    await until(() => !state.writable);
    assert.equal(state.initialized, true);
    assert.equal(quick.response(guildId, "hello"), "Public response");
    assert.equal(auth.authenticate(sessionToken).userId, "7");
    assert.throws(() => auth.beginLogin(), { code: "STATE_UNAVAILABLE" });
    const user = {
        id: "7",
        username: "Tester",
        avatarURL: "https://example.com/avatar.png",
        createdTimestamp: 100,
        joinedTimestamp: 200,
        roles: [],
      },
      context = {
        guildId,
        user,
        options: {},
        users: {},
        latencyMs: 42,
        command: "",
      };
    const results = {};
    for (const plugin of builtInPlugins)
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
    for (const plugin of builtInPlugins)
      assert.equal(plugins.runtimeStatus(plugin.id).pid, pids[plugin.id]);
    await assert.rejects(
      plugins.setEnabled(
        "ping",
        guildId,
        false,
        plugins.configuration("ping", guildId).revision,
      ),
      { code: "STATE_UNAVAILABLE" },
    );
    await assert.rejects(
      quick.delete(guildId, "hello", quick.list(guildId)[0].revision),
      { code: "STATE_UNAVAILABLE" },
    );
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
    let actual = [],
      writes = 0;
    const registry = new CommandRegistry(plugins),
      reconciler = new CommandReconciler("9", registry, {
        get: async () => actual,
        post: async (route, { body }) => {
          actual.push({ ...body, id: String(++writes) });
        },
        patch: async () => {
          writes++;
        },
        delete: async () => {
          writes++;
        },
      });
    await reconciler.reconcile(guildId);
    assert.equal(actual.length, 5);
    const count = writes;
    await reconciler.reconcile(guildId);
    assert.equal(writes, count);
    await reconciler.close();
    const cold = new StateStore(
      new SpacetimeTransport({ url, database, token }),
    );
    t.after(() => cold.close());
    const waiting = cold.start();
    await delay(200);
    assert.equal(cold.initialized, false);
    assert.equal(cold.writable, false);
    start();
    await until(() => cold.initialized);
    await waiting;
    await until(() => state.writable);
    assert.equal(quick.response(guildId, "hello"), "Public response");
    assert.equal(
      cold.get("quick", guildId, "hello").data.response,
      "Public response",
    );
    // Lose reducer confirmation deliberately; the application never retries the mutation.
    const connection = transport.connection,
      original = connection.reducers.mutateState.bind(connection.reducers);
    let attempts = 0;
    connection.reducers.mutateState = (args) => {
      attempts++;
      const write = original(args);
      connection.disconnect();
      return write;
    };
    await assert.rejects(
      quick.save(
        guildId,
        {
          guildId,
          trigger: "uncertain",
          response: "Committed only if the server received it",
          enabled: true,
        },
        "0",
      ),
      { code: "WRITE_UNCONFIRMED" },
    );
    assert.equal(quick.response(guildId, "uncertain"), undefined);
    await until(() => state.writable);
    assert.equal(attempts, 1);
    const recovered = quick.response(guildId, "uncertain");
    assert.ok(
      recovered === undefined ||
        recovered === "Committed only if the server received it",
    );
  },
);
