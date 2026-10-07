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
async function fixture(t) {
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
