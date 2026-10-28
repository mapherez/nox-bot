import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AuthService } from "../dist/core/auth.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { MessagingService } from "../dist/core/messaging.js";
import { DashboardServer } from "../dist/services/dashboard.js";
import { memoryState } from "./fixtures/state.mjs";
import { fakeOperations, quietLogger } from "./helpers.mjs";
quietLogger();
async function fixture(t, now = Date.now, voice) {
  const f = await memoryState(t),
    auth = new AuthService(
      f.state,
      {
        clientId: "9",
        clientSecret: "fixture-secret",
        ownerId: "7",
        origin: "http://localhost",
        sessionSecret: randomBytes(32).toString("base64"),
      },
      {
        authorizeURL: (state) => `https://discord.example?state=${state}`,
        identify: async () => ({ id: "7", username: "Owner", avatar: null }),
      },
      now,
    );
  await auth.initializeOwner();
  const login = auth.beginLogin(),
    state = new URL(login.url).searchParams.get("state"),
    signed = await auth.completeLogin("code", state, state);
  const server = new DashboardServer(
    { host: "127.0.0.1", port: 0, publicOrigin: "http://localhost" },
    auth,
    f.state,
    fakeOperations(),
    f.plugins,
    new QuickCommandService(f.state),
    undefined,
    new MessagingService([]),
    undefined,
    undefined,
    undefined,
    voice,
  );
  await server.start();
  t.after(() => server.stop());
  const origin = `http://127.0.0.1:${server.address().port}`,
    headers = {
      Cookie: signed.cookie.split(";")[0],
      Origin: "http://localhost",
      "X-CSRF-Token": signed.session.csrf,
      "Content-Type": "application/json",
    };
  const call = (resource, method = "GET", body, extra = {}) =>
    fetch(`${origin}${resource}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...f, auth, server, call, origin, headers };
}
test("dashboard renews the cookie and persisted session for one year and logout clears both", async (t) => {
  const year = 365 * 24 * 60 * 60 * 1000;
  let clock = 1000000;
  const f = await fixture(t, () => clock);
  const token = f.headers.Cookie.split("=")[1];
  const originalExpiry = f.auth.authenticate(token, false).expiresAt;
  clock += 180 * 24 * 60 * 60 * 1000;
  const responses = await Promise.all([
    f.call("/dashboard/api/session"),
    f.call("/dashboard/api/session"),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("set-cookie"),
      `${f.headers.Cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    );
    assert.equal((await response.json()).expiresAt, clock + year);
  }
  assert.equal(f.auth.authenticate(token, false).expiresAt, clock + year);
  clock = originalExpiry + 1;
  assert.equal((await f.call("/dashboard/api/session")).status, 200);
  const logout = await f.call("/auth/logout", "POST", {});
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /^nox-session=;.*Max-Age=0$/);
  const loggedOut = await f.call("/dashboard/api/session");
  assert.equal(loggedOut.status, 401);
  assert.equal(loggedOut.headers.get("set-cookie"), null);
});
test("dashboard upgrades an unexpired legacy session to one year without another login", async (t) => {
  const day = 24 * 60 * 60 * 1000;
  let clock = 1000000;
  const f = await fixture(t, () => clock);
  const token = f.headers.Cookie.split("=")[1];
  const session = f.auth.authenticate(token, false);
  await f.state.put("session", "", session.hash, {
    ...session,
    expiresAt: session.createdAt + day,
  });
  const response = await f.call("/dashboard/api/session");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /; Max-Age=31536000$/);
  assert.equal((await response.json()).expiresAt, clock + 365 * day);
  clock += 2 * day;
  assert.equal((await f.call("/dashboard/api/session")).status, 200);
});
test("dashboard requires owner session and verified CSRF/Origin before guild/config access", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/dashboard/api/guilds`)).status, 401);
  assert.equal((await f.call("/dashboard/api/guilds/2")).status, 404);
  assert.equal(
    (
      await f.call(
        "/dashboard/api/guilds/1/plugins/ping/enabled",
        "PUT",
        { enabled: true, expectedRevision: "0" },
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/dashboard/api/guilds/1/plugins/ping/enabled",
        "PUT",
        { enabled: true, expectedRevision: "0" },
        { "X-CSRF-Token": "" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        "/auth/logout",
        "POST",
        {},
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.equal(f.plugins.configuration("ping", "1").enabled, false);
});
test("CRUD has revision conflicts and sanitizes secrets in reads and SSE; existing sessions work offline", async (t) => {
  const f = await fixture(t),
    endpoint = "/dashboard/api/guilds/1";
  let response = await f.call(`${endpoint}/plugins/weather/settings`, "PUT", {
    settings: { units: "celsius", defaultLocation: "Lisbon" },
    secrets: { apiKey: "private-weather-key" },
    expectedRevision: "0",
  });
  assert.equal(response.status, 200);
  const snapshot = await response.json(),
    weather = snapshot.plugins.find((plugin) => plugin.id === "weather");
  assert.deepEqual(weather.configuration.secrets.apiKey, { configured: true });
  assert.equal(JSON.stringify(snapshot).includes("private-weather-key"), false);
  assert.equal(JSON.stringify(snapshot).includes("aes256gcm"), false);
  response = await f.call(`${endpoint}/quick-commands`, "POST", {
    trigger: "HELLO",
    response: "Public response",
    enabled: true,
    expectedRevision: "0",
  });
  assert.equal(response.status, 200);
  const first = (await response.json()).quickCommands[0];
  assert.equal(first.trigger, "hello");
  assert.equal(
    (
      await f.call(`${endpoint}/quick-commands/hello`, "PUT", {
        trigger: "hello",
        response: "overwrite",
        enabled: true,
        expectedRevision: "0",
      })
    ).status,
    409,
  );
  const controller = new AbortController(),
    stream = await fetch(`${f.origin}${endpoint}/events`, {
      headers: f.headers,
      signal: controller.signal,
    }),
    reader = stream.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: snapshot/);
  assert.equal(initial.includes("private-weather-key"), false);
  f.disconnect();
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /reconnecting/);
  assert.match(update, /Public response/);
  assert.equal((await f.call(endpoint)).status, 200);
  assert.equal((await f.call("/dashboard/api/session")).status, 200);
  assert.equal(
    (
      await f.call(`${endpoint}/quick-commands/hello`, "DELETE", {
        expectedRevision: first.revision,
      })
    ).status,
    503,
  );
  assert.equal((await f.call("/auth/logout", "POST", {})).status, 503);
  await f.recover();
  controller.abort();
  await reader.cancel().catch(() => {});
  assert.equal(
    (
      await f.call(`${endpoint}/quick-commands/hello`, "DELETE", {
        expectedRevision: first.revision,
      })
    ).status,
    200,
  );
  assert.equal((await f.call("/auth/logout", "POST", {})).status, 200);
  assert.equal((await f.call("/dashboard/api/session")).status, 401);
});
test("dashboard static assets use same origin, security headers and block traversal", async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.origin);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.match(await response.text(), /NoX Bot/);
  assert.equal((await fetch(`${f.origin}/%2e%2e%2fpackage.json`)).status, 404);
});

test("voice routes preserve owner auth, CSRF, guild boundaries and the separate text-channel contract", async (t) => {
  const calls = [];
  const voice = {
    async channels(guildId) {
      calls.push(["channels", guildId]);
      return [{ id: "10", name: "Voice" }];
    },
    async status(guildId) {
      calls.push(["status", guildId]);
      return { configured: false, state: "inactive" };
    },
    async diagnostics(guildId) {
      calls.push(["diagnostics", guildId]);
      return { controller: "ready" };
    },
    async applySettings(guildId, settings) {
      calls.push(["settings", guildId, settings]);
      return settings;
    },
    async action(guildId, action) {
      calls.push(["action", guildId, action]);
      return { state: "starting" };
    },
  };
  const f = await fixture(t, Date.now, voice),
    base = "/dashboard/api/guilds/1/voice";
  assert.equal((await fetch(`${f.origin}${base}/status`)).status, 401);
  assert.equal(
    (await f.call("/dashboard/api/guilds/2/voice/status")).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        `${base}/engine/start`,
        "POST",
        {},
        { Origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.deepEqual(calls, []);
  assert.equal((await f.call(`${base}/channels`)).status, 200);
  assert.equal((await f.call(`${base}/status`)).status, 200);
  assert.equal((await f.call(`${base}/diagnostics`)).status, 200);
  assert.equal((await f.call(`${base}/engine/start`, "POST", {})).status, 202);
  const settings = { voice: "NATF0", prompt: "Hello", bits: 4 };
  assert.equal((await f.call(`${base}/settings`, "PUT", settings)).status, 200);
  const count = calls.length;
  assert.equal(
    (
      await f.call(`${base}/settings`, "PUT", {
        ...settings,
        controllerUrl: "https://attacker.example",
      })
    ).status,
    400,
  );
  assert.equal((await f.call(`${base}/engine/start`, "GET")).status, 405);
  assert.equal(calls.length, count);
  const text = await f.call("/dashboard/api/guilds/1/channels");
  assert.equal(text.status, 200);
  assert.ok(!(await text.json()).some((channel) => channel.id === "10"));
  f.disconnect();
  assert.equal((await f.call(`${base}/status`)).status, 200);
  assert.equal((await f.call(`${base}/engine/stop`, "POST", {})).status, 503);
});

test("Quick Command backup routes export the complete portable list and import with owner/CSRF/guild checks", async (t) => {
  const f = await fixture(t),
    base = "/dashboard/api/guilds/1/quick-commands";
  const entry = {
    trigger: "disabled",
    response: "Backup response\nwith formatting",
    enabled: false,
  };
  assert.equal(
    (await f.call(base, "POST", { ...entry, expectedRevision: "0" })).status,
    200,
  );
  let response = await f.call(`${base}/export`);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-disposition"),
    /attachment.*\.json/,
  );
  assert.deepEqual(await response.json(), [entry]);
  const commands = [
    { ...entry, response: "Updated", enabled: true },
    { trigger: "new", response: "New", enabled: false },
  ];
  const row = f.state.get("quick", "1", entry.trigger);
  const input = {
    commands,
    expectedRevisions: { disabled: row.revision, new: "0" },
  };
  assert.equal((await fetch(`${f.origin}${base}/export`)).status, 401);
  assert.equal(
    (
      await f.call(`${base}/import`, "POST", input, {
        Origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.call("/dashboard/api/guilds/2/quick-commands/export")).status,
    404,
  );
  response = await f.call(`${base}/import`, "POST", input);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quickCommands.length, 2);
  assert.equal(f.state.get("quick", "1", "disabled").data.response, "Updated");
  assert.equal((await f.call(`${base}/import`, "POST", input)).status, 409);
  assert.equal(
    (
      await f.call(`${base}/import`, "POST", {
        commands: [{ ...entry, guildId: "2" }],
        expectedRevisions: { disabled: "0" },
      })
    ).status,
    400,
  );
  assert.equal(f.state.get("quick", "2", entry.trigger), undefined);
  f.disconnect();
  assert.equal((await f.call(`${base}/export`)).status, 200);
  assert.equal((await f.call(`${base}/import`, "POST", input)).status, 503);
});
test("backup import accepts complete lists larger than the normal JSON body limit", async (t) => {
  const f = await fixture(t),
    base = "/dashboard/api/guilds/1/quick-commands";
  const commands = Array.from({ length: 50 }, (_, i) => ({
    trigger: `backup${i}`,
    response: "x".repeat(2000),
    enabled: i % 2 === 0,
  }));
  const expectedRevisions = Object.fromEntries(
    commands.map((command) => [command.trigger, "0"]),
  );
  const response = await f.call(`${base}/import`, "POST", {
    commands,
    expectedRevisions,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quickCommands.length, 50);
  assert.deepEqual(
    (await (await f.call(`${base}/export`)).json())
      .map((row) => row.trigger)
      .sort(),
    commands.map((row) => row.trigger).sort(),
  );
});
