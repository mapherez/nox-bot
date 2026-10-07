import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
  Status,
} from "discord.js";
import { AuthService } from "../dist/core/auth.js";
import { MessagingService } from "../dist/core/messaging.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { CommandRegistry } from "../dist/core/commandRegistry.js";
import { StateError } from "../dist/core/state.js";
import DiscordOperations from "../dist/services/discordOperations.js";
import { DashboardServer } from "../dist/services/dashboard.js";
import { memoryState } from "./fixtures/state.mjs";
import { deferred, until, quietLogger } from "./helpers.mjs";
quietLogger();

const metadata = {
  status: "status",
  guild_get_id: "guild get id",
  channel_list: "channel list",
  message_send: "message send",
  command_list: "command list",
  plugin_list: "plugin list",
  plugin_get: "plugin get",
  plugin_enable: "plugin enable",
  plugin_disable: "plugin disable",
  plugin_configure: "plugin configure",
  quick_command_list: "quick-command list",
  quick_command_create: "quick-command create",
  quick_command_update: "quick-command update",
  quick_command_delete: "quick-command delete",
};

async function fixture(t) {
  const f = await memoryState(t);
  let state = "running";
  const member = { isCommunicationDisabled: () => false };
  const sent = [];
  const channels = new Map();
  const guilds = new Map(
    ["1", "2"].map((id) => [
      id,
      {
        id,
        name: `Server ${id}`,
        available: true,
        members: { me: member, fetchMe: async () => member },
        channels: {
          fetch: async () =>
            new Map(
              [...channels].filter(([, channel]) => channel.guildId === id),
            ),
        },
      },
    ]),
  );
  for (const [id, guildId, allowed] of [
    ["11", "1", true],
    ["12", "1", false],
    ["22", "2", true],
  ]) {
    channels.set(id, {
      id,
      guildId,
      name: `channel-${id}`,
      type: ChannelType.GuildText,
      permissionsFor: () =>
        new PermissionsBitField(
          allowed
            ? [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
              ]
            : [],
        ),
      send: async (payload) => {
        sent.push({ guildId, channelId: id, payload });
        return { id: "33", channelId: id };
      },
    });
  }
  const client = {
    isReady: () => true,
    ws: { status: Status.Ready, ping: 42 },
    user: { id: "7", username: "NoX", token: "discord-secret" },
    guilds: { cache: guilds },
    channels: { fetch: async (id) => channels.get(id) ?? null },
  };
  const operations = new DiscordOperations(client);
  const messaging = new MessagingService([operations]);
  const auth = new AuthService(
    f.state,
    {
      clientId: "9",
      clientSecret: "oauth-secret",
      ownerId: "7",
      origin: "https://bot.example.com",
      sessionSecret: randomBytes(32).toString("base64"),
    },
    {
      authorizeURL: (state) => `https://discord.example?state=${state}`,
      identify: async () => ({ id: "7", username: "Owner", avatar: null }),
    },
  );
  await auth.initializeOwner();
  const quick = new QuickCommandService(f.state);
  const registry = new CommandRegistry(f.plugins);
  const server = new DashboardServer(
    { host: "127.0.0.1", port: 0, publicOrigin: "https://bot.example.com" },
    auth,
    f.state,
    operations,
    f.plugins,
    quick,
    () => ({ state: "synced" }),
    messaging,
    registry,
    { service: "nox-bot", version: "test", apiVersion: "v1", capabilities: [] },
    () => state,
  );
  await server.start();
  t.after(() => server.stop());
  const origin = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  async function rpc(method, params = {}, guildId = "1", extra = {}) {
    const response = await fetch(`${origin}/mcp/guilds/${guildId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      ...extra,
    });
    const body = await response.text();
    const data = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? JSON.parse(
          body
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .at(-1)
            .slice(6),
        )
      : JSON.parse(body);
    return { response, data };
  }
  async function call(name, args = {}, guildId = "1", extra) {
    const { response, data } = await rpc(
      "tools/call",
      { name, arguments: args },
      guildId,
      extra,
    );
    assert.equal(response.status, 200, JSON.stringify(data));
    return data.result ?? data;
  }
  return {
    ...f,
    client,
    channels,
    sent,
    operations,
    messaging,
    auth,
    quick,
    registry,
    server,
    origin,
    rpc,
    call,
    setProcess: (value) => {
      state = value;
    },
  };
}

function success(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  return result.structuredContent;
}
function failure(result, code) {
  assert.equal(result.isError, true, JSON.stringify(result));
  if (code) assert.equal(result.structuredContent.code, code);
  return result.structuredContent;
}

test("guild MCP is always available without auth, exposes exactly 14 strict tools and preserves CLI metadata", async (t) => {
  const f = await fixture(t);
  const initialized = await f.rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.data.result.serverInfo.name, "nox-bot-1");
  const { data } = await f.rpc("tools/list");
  assert.deepEqual(
    Object.fromEntries(
      data.result.tools.map((tool) => [tool.name, tool._meta.cli]),
    ),
    metadata,
  );
  for (const tool of data.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.guildId, undefined);
    assert.ok(tool.outputSchema);
  }
  for (const name of [
    "guild_list",
    "weather",
    "dictionary_lookup",
    "user_info",
    "ping",
  ]) {
    const result = await f.call(name);
    assert.ok(result.error || result.isError);
  }
  const status = success(await f.call("status"));
  assert.equal(status.guildId, "1");
  assert.equal(status.version, "test");
  assert.equal(status.discord.pingMs, 42);
  assert.equal(status.writable, true);
  assert.equal(status.guildCount, undefined);
  assert.equal(JSON.stringify(status).includes("discord-secret"), false);
  assert.equal((await fetch(`${f.origin}/dashboard/api/guilds`)).status, 401);
  assert.equal((await fetch(`${f.origin}/mcp`)).status, 404);
});

test("guild ID, channels and sends stay bound to the URL and preserve Discord permission checks", async (t) => {
  const f = await fixture(t);
  for (const guildId of ["1", "2"]) {
    assert.deepEqual(success(await f.call("guild_get_id", {}, guildId)), {
      guildId,
    });
    assert.deepEqual(
      success(await f.call("channel_list", {}, guildId)).channels.map(
        (c) => c.id,
      ),
      [guildId === "1" ? "11" : "22"],
    );
  }
  for (const tool of Object.keys(metadata)) {
    const { data } = await f.rpc("tools/call", {
      name: tool,
      arguments: { guildId: "2" },
    });
    assert.ok(data.error || data.result?.isError, tool);
  }
  failure(
    await f.call("message_send", { channelId: "22", content: "cross-server" }),
    "INVALID_CHANNEL",
  );
  failure(
    await f.call("message_send", { channelId: "12", content: "denied" }),
    "INSUFFICIENT_PERMISSIONS",
  );
  failure(await f.call("message_send", { channelId: "11", content: " " }));
  failure(
    await f.call("message_send", {
      channelId: "11",
      content: "x".repeat(2001),
    }),
    "INVALID_PAYLOAD",
  );
  failure(
    await f.call("message_send", { channelId: "abc", content: "x" }),
    "INVALID_PAYLOAD",
  );
  assert.equal(f.sent.length, 0);
  const text = " original @everyone <@7> \n";
  assert.deepEqual(
    success(await f.call("message_send", { channelId: "11", content: text })),
    { guildId: "1", channelId: "11", messageId: "33" },
  );
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].guildId, "1");
  assert.equal(f.sent[0].channelId, "11");
  assert.equal(f.sent[0].payload.content, text);
  assert.deepEqual(f.sent[0].payload.allowedMentions, { parse: [] });
});

test("plugin management reuses validation and workers without executing plugins; reads redact secrets", async (t) => {
  const f = await fixture(t);
  let executions = 0;
  const execute = f.plugins.execute.bind(f.plugins);
  f.plugins.execute = (...args) => {
    executions++;
    return execute(...args);
  };
  assert.equal(success(await f.call("plugin_list")).plugins.length, 4);
  assert.deepEqual(
    success(await f.call("command_list")).commands.map((c) => c.name),
    ["nox"],
  );
  let weather = success(
    await f.call("plugin_get", { pluginId: "weather" }),
  ).plugin;
  assert.equal(weather.configuration.revision, "0");
  failure(
    await f.call("plugin_enable", {
      pluginId: "weather",
      expectedRevision: "0",
    }),
    "INVALID_REQUEST",
  );
  failure(
    await f.call("plugin_configure", {
      pluginId: "weather",
      settings: { units: "invalid", defaultLocation: "Lisbon" },
      expectedRevision: "0",
    }),
    "INVALID_REQUEST",
  );
  const configured = success(
    await f.call("plugin_configure", {
      pluginId: "weather",
      settings: { units: "celsius", defaultLocation: "Lisbon" },
      secrets: { apiKey: "private-weather-key" },
      expectedRevision: "0",
    }),
  );
  assert.equal(
    JSON.stringify(configured).includes("private-weather-key"),
    false,
  );
  assert.equal(JSON.stringify(configured).includes("aes256gcm"), false);
  weather = configured.plugins.find((p) => p.id === "weather");
  assert.deepEqual(weather.configuration.secrets.apiKey, { configured: true });
  assert.deepEqual(
    success(await f.call("plugin_get", { pluginId: "weather" }, "2")).plugin
      .configuration.secrets.apiKey,
    { configured: false },
  );
  let updated = success(
    await f.call("plugin_configure", {
      pluginId: "weather",
      settings: { units: "fahrenheit", defaultLocation: "Porto" },
      expectedRevision: weather.configuration.revision,
    }),
  ).plugins.find((p) => p.id === "weather");
  assert.deepEqual(updated.configuration.secrets.apiKey, { configured: true });
  updated = success(
    await f.call("plugin_configure", {
      pluginId: "weather",
      settings: updated.configuration.settings,
      secrets: { apiKey: "replacement-weather-key" },
      expectedRevision: updated.configuration.revision,
    }),
  ).plugins.find((p) => p.id === "weather");
  const removed = success(
    await f.call("plugin_configure", {
      pluginId: "weather",
      settings: updated.configuration.settings,
      secrets: { apiKey: null },
      expectedRevision: updated.configuration.revision,
    }),
  );
  assert.deepEqual(
    removed.plugins.find((p) => p.id === "weather").configuration.secrets
      .apiKey,
    { configured: false },
  );
  failure(
    await f.call("plugin_get", { pluginId: "unknown" }),
    "INVALID_REQUEST",
  );
  const enabled = success(
    await f.call("plugin_enable", { pluginId: "ping", expectedRevision: "0" }),
  );
  const ping = enabled.plugins.find((p) => p.id === "ping");
  assert.equal(ping.configuration.enabled, true);
  assert.equal(
    success(await f.call("plugin_get", { pluginId: "ping" }, "2")).plugin
      .configuration.enabled,
    false,
  );
  assert.deepEqual(
    success(await f.call("command_list")).commands.map((c) => c.name),
    ["nox", "ping"],
  );
  assert.deepEqual(
    success(await f.call("command_list", {}, "2")).commands.map((c) => c.name),
    ["nox"],
  );
  failure(
    await f.call("plugin_disable", { pluginId: "ping", expectedRevision: "0" }),
    "STATE_CONFLICT",
  );
  assert.equal(
    success(
      await f.call("plugin_disable", {
        pluginId: "ping",
        expectedRevision: ping.configuration.revision,
      }),
    ).plugins.find((p) => p.id === "ping").configuration.enabled,
    false,
  );
  assert.equal(executions, 0);
});

test("Quick Command CRUD preserves normalization, guild isolation, revisions and confirmed state", async (t) => {
  const f = await fixture(t);
  const input = { trigger: " HELLO ", response: "first", enabled: true };
  let snapshot = success(await f.call("quick_command_create", input));
  let command = snapshot.quickCommands[0];
  assert.equal(command.trigger, "hello");
  assert.deepEqual(
    success(await f.call("quick_command_list", {}, "2")).quickCommands,
    [],
  );
  failure(await f.call("quick_command_create", input), "STATE_CONFLICT");
  failure(
    await f.call("quick_command_create", { ...input, trigger: "help" }),
    "INVALID_STATE",
  );
  failure(
    await f.call("quick_command_update", { ...input, expectedRevision: "0" }),
    "STATE_CONFLICT",
  );
  snapshot = success(
    await f.call("quick_command_update", {
      trigger: "HELLO",
      response: "second",
      enabled: false,
      expectedRevision: command.revision,
    }),
  );
  command = snapshot.quickCommands[0];
  assert.equal(command.response, "second");
  assert.equal(command.enabled, false);
  failure(
    await f.call("quick_command_delete", {
      trigger: "hello",
      expectedRevision: "0",
    }),
    "STATE_CONFLICT",
  );
  assert.deepEqual(
    success(
      await f.call("quick_command_delete", {
        trigger: "HELLO",
        expectedRevision: command.revision,
      }),
    ).quickCommands,
    [],
  );
});

test("DB interruptions retain confirmed reads, block writes, recover without replay and preserve unknown outcomes", async (t) => {
  const f = await fixture(t);
  const input = { trigger: "hello", response: "confirmed", enabled: true };
  await f.call("quick_command_create", input);
  f.disconnect();
  const status = success(await f.call("status"));
  assert.equal(status.writable, false);
  assert.equal(status.synchronization, "reconnecting");
  assert.equal(
    success(await f.call("quick_command_list")).quickCommands[0].response,
    "confirmed",
  );
  success(await f.call("plugin_list"));
  success(await f.call("command_list"));
  success(
    await f.call("message_send", { channelId: "11", content: "still running" }),
  );
  failure(
    await f.call("quick_command_create", { ...input, trigger: "offline" }),
    "STATE_UNAVAILABLE",
  );
  failure(
    await f.call("plugin_enable", { pluginId: "ping", expectedRevision: "0" }),
    "STATE_UNAVAILABLE",
  );
  await f.recover();
  assert.equal(success(await f.call("status")).writable, true);
  assert.deepEqual(
    success(await f.call("quick_command_list")).quickCommands.map(
      (c) => c.trigger,
    ),
    ["hello"],
  );
  let writes = 0;
  f.transport.mutate = async () => {
    writes++;
    throw new StateError("WRITE_UNCONFIRMED", "Confirmation was lost.");
  };
  const error = failure(
    await f.call("quick_command_create", { ...input, trigger: "unknown" }),
    "WRITE_UNCONFIRMED",
  );
  assert.deepEqual(error.details, { outcome: "unknown" });
  assert.equal(error.retryable, false);
  assert.equal(writes, 1);
});

test("each request revalidates guild installation; missing, invalid and removed guilds are unavailable", async (t) => {
  const f = await fixture(t);
  for (const [guildId, status, code] of [
    ["3", 404, "GUILD_NOT_FOUND"],
    ["invalid", 400, "INVALID_PAYLOAD"],
  ]) {
    const reply = await f.rpc("tools/list", {}, guildId);
    assert.equal(reply.response.status, status);
    assert.equal(reply.data.code, code);
  }
  success(await f.call("guild_get_id", {}, "2"));
  f.client.guilds.cache.delete("2");
  assert.equal(
    (
      await f.rpc(
        "tools/call",
        { name: "quick_command_list", arguments: {} },
        "2",
      )
    ).response.status,
    404,
  );
  f.client.isReady = () => false;
  assert.equal((await f.rpc("tools/list")).response.status, 503);
});

test("dashboard snapshots expose distinct public MCP URLs without Host-header trust", async (t) => {
  const f = await fixture(t);
  const login = f.auth.beginLogin();
  const state = new URL(login.url).searchParams.get("state");
  const signed = await f.auth.completeLogin("code", state, state);
  for (const guildId of ["1", "2"]) {
    const response = await fetch(
      `${f.origin}/dashboard/api/guilds/${guildId}`,
      {
        headers: { Cookie: signed.cookie.split(";")[0], Host: "other.example" },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).mcp, {
      url: `https://bot.example.com/mcp/guilds/${guildId}`,
    });
  }
});

test("cancelled MCP sends do not commit after asynchronous channel lookup", async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  let entered = false,
    signal;
  const send = f.messaging.send.bind(f.messaging);
  f.messaging.send = (target, content, receivedSignal) => {
    signal = receivedSignal;
    return send(target, content, receivedSignal);
  };
  f.client.channels.fetch = async (id) => {
    entered = true;
    await gate.promise;
    return f.channels.get(id);
  };
  const controller = new AbortController();
  const work = f.call(
    "message_send",
    { channelId: "11", content: "cancelled" },
    "1",
    { signal: controller.signal },
  );
  const rejected = assert.rejects(work);
  await until(() => entered);
  controller.abort();
  await rejected;
  await until(() => signal?.aborted);
  gate.resolve();
  await f.server.stop();
  assert.deepEqual(f.sent, []);
});

test("startup permits status and refuses effects; stopping refuses all new MCP requests", async (t) => {
  const f = await fixture(t);
  f.setProcess("starting");
  assert.equal(success(await f.call("status")).process.state, "starting");
  failure(
    await f.call("quick_command_create", {
      trigger: "startup",
      response: "blocked",
      enabled: true,
    }),
    "SERVICE_UNAVAILABLE",
  );
  failure(
    await f.call("message_send", { channelId: "11", content: "blocked" }),
    "SERVICE_UNAVAILABLE",
  );
  assert.deepEqual(f.quick.list("1"), []);
  f.setProcess("stopping");
  for (const name of ["status", "message_send", "quick_command_create"]) {
    const reply = await f.rpc("tools/call", { name, arguments: {} });
    assert.equal(reply.response.status, 503);
    assert.equal(reply.data.code, "SERVICE_UNAVAILABLE");
  }
  assert.deepEqual(f.sent, []);
});

test("shutdown drains accepted writes and closes idempotently", async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const mutate = f.transport.mutate.bind(f.transport);
  let entered = false;
  f.transport.mutate = async (changes) => {
    entered = true;
    await gate.promise;
    await mutate(changes);
  };
  const work = f.call("quick_command_create", {
    trigger: "drain",
    response: "accepted",
    enabled: true,
  });
  await until(() => entered);
  f.setProcess("stopping");
  const stopping = f.server.stop();
  assert.equal(f.server.stop(), stopping);
  let closed = false;
  void stopping.then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  gate.resolve();
  assert.equal(success(await work).quickCommands[0].trigger, "drain");
  await stopping;
  assert.equal(f.server.address(), null);
  assert.deepEqual(f.sent, []);
});
