import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import ControlApi from "../dist/services/controlApi.js";
import { ControlError, errorStatuses } from "../dist/controlApi.js";
import { createServiceInfo } from "../dist/utils/runtimeVersion.js";
import { env, key, fakeOperations, deferred, until, quietLogger } from "./helpers.mjs";

quietLogger();

async function fixture(t, overrides = {}) {
  const state = { value: "running" };
  const operations = { ...fakeOperations(), ...overrides };
  const api = new ControlApi({ enabled: true, host: "127.0.0.1", port: 0, key }, operations, createServiceInfo("v1.9.4"), () => state.value);
  await api.start();
  t.after(() => api.stop());
  const base = `http://127.0.0.1:${api.address().port}`;
  const call = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { Authorization: `Bearer ${key}`, ...options.headers } });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const post = (payload, options = {}) => call("/v1/messages", {
    method: "POST", ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return { api, state, operations, base, call, post };
}

test("public metadata contracts and readiness track startup, connection and shutdown", async (t) => {
  const f = await fixture(t);
  const info = await f.call("/v1/info", { headers: { Authorization: "invalid" } });
  assert.equal(info.status, 200);
  assert.deepEqual(info.body, { service: "nox-bot", version: "v1.9.4", apiVersion: "v1", capabilities: ["discord-status", "guilds", "channels", "messages"] });
  const health = await f.call("/v1/health", { headers: { Authorization: "" } });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { service: "nox-bot", version: info.body.version, apiVersion: "v1", ready: true, process: { state: "running" }, discord: { state: "connected", ready: true } });
  assert.equal(health.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(health.headers.get("cache-control"), "no-store");
  f.state.value = "starting";
  assert.equal((await f.call("/v1/health")).status, 503);
  assert.equal((await f.call("/v1/guilds")).body.code, "SERVICE_UNAVAILABLE");
  f.state.value = "running";
  f.operations.getStatus = () => ({ discord: { state: "reconnecting", ready: false, pingMs: null }, bot: null, guildCount: 0 });
  assert.equal((await f.call("/v1/health")).status, 503);
  assert.deepEqual((await f.call("/v1/status")).body, f.operations.getStatus());
  assert.equal((await f.call("/v1/status")).status, 200);
  f.operations.getStatus = fakeOperations().getStatus;
  assert.equal((await f.call("/v1/health")).status, 200);
  f.state.value = "stopping";
  assert.equal((await f.call("/v1/health")).status, 503);
  assert.equal((await f.call("/v1/status")).body.code, "SERVICE_UNAVAILABLE");
});

test("authenticated success contracts preserve original message content", async (t) => {
  let sent;
  const f = await fixture(t, { sendMessage: async (...args) => { sent = args; return { messageId: "3", channelId: args[0], guildId: "1" }; } });
  assert.deepEqual((await f.call("/v1/status")).body, f.operations.getStatus());
  assert.deepEqual((await f.call("/v1/guilds")).body, { guilds: [{ id: "1", name: "Guild" }] });
  assert.deepEqual((await f.call("/v1/guilds/1/channels")).body, { guildId: "1", channels: [{ id: "2", name: "general", type: "text" }] });
  const content = " \t@everyone test message\n ";
  const result = await f.post({ channelId: "123456789", content }, { headers: { "Content-Type": "application/json; charset=UTF-8" } });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { messageId: "3", channelId: "123456789", guildId: "1" });
  assert.deepEqual(sent, ["123456789", content]);
});

test("every protected route authenticates before validation or service access", async (t) => {
  let calls = 0;
  const fail = () => { calls++; throw new Error("Must not be called"); };
  const f = await fixture(t, { getStatus: fail, listGuilds: fail, listChannels: fail, sendMessage: fail });
  for (const path of ["/v1/status", "/v1/guilds", "/v1/guilds/not-an-id/channels", "/v1/messages"]) {
    const response = await fetch(f.base + path, { method: path.endsWith("messages") ? "POST" : "GET" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "AUTH_REQUIRED");
    for (const Authorization of [`Bearer ${env.DISCORD_TOKEN}`, "Basic test", "Bearer", `bearer ${key}`, `Bearer ${key} extra`]) {
      assert.equal((await f.call(path, { headers: { Authorization } })).body.code, "AUTH_INVALID");
    }
  }
  assert.equal((await fetch(f.base + "/v1/status?api_key=" + key)).status, 401);
  const duplicated = await new Promise((resolve, reject) => {
    const request = httpRequest(f.base + "/v1/status", { headers: ["Host", new URL(f.base).host, "Authorization", `Bearer ${key}`, "Authorization", `Bearer ${key}`] }, (response) => {
      let body = "";
      response.on("data", (chunk) => body += chunk);
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(duplicated.status, 401);
  assert.equal(duplicated.body.code, "AUTH_INVALID");
  assert.equal(calls, 0);
});

test("payload validation rejects whitespace, wrong fields, IDs, JSON and body sizes", async (t) => {
  let calls = 0;
  const f = await fixture(t, { sendMessage: async () => { calls++; return {}; } });
  const invalid = [null, [], {}, { channelId: "2" }, { channelId: 2, content: "x" },
    { channelId: "0", content: "x" }, { channelId: "18446744073709551616", content: "x" },
    { channelId: "2", content: "", }, { channelId: "2", content: " \t\r\n " },
    { channelId: "2", content: "x".repeat(2001) }, { channelId: "2", content: "😀".repeat(1001) },
    { channelId: "2", content: "x", embeds: [] }, { channelId: "2", content: null }];
  for (const payload of invalid) {
    const result = await f.post(payload);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_PAYLOAD");
  }
  assert.equal((await f.post("{broken")).body.code, "INVALID_PAYLOAD");
  assert.equal((await f.post({ channelId: "2", content: "x" }, { headers: { "Content-Type": "text/plain" } })).status, 415);
  const oversized = await f.post(" ".repeat(16 * 1024 + 1));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, "PAYLOAD_TOO_LARGE");
  assert.equal((await f.call("/v1/guilds/bad/channels")).body.code, "INVALID_PAYLOAD");
  assert.equal(calls, 0);
  assert.equal((await f.post({ channelId: "18446744073709551615", content: "😀".repeat(1000) })).status, 201);
});

test("route and method errors use the contract", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/unknown/info")).body.code, "ROUTE_NOT_FOUND");
  const wrong = await f.call("/v1/messages");
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "POST");
  assert.equal(wrong.body.code, "METHOD_NOT_ALLOWED");
});

test("domain errors are stable and unknown upstream metadata stays private", async (t) => {
  const f = await fixture(t);
  for (const code of ["GUILD_NOT_FOUND", "CHANNEL_NOT_FOUND", "INVALID_CHANNEL", "INSUFFICIENT_PERMISSIONS", "DISCORD_UNAVAILABLE", "MESSAGE_REJECTED"]) {
    f.operations.sendMessage = async () => { throw new ControlError(code, "Safe description."); };
    const result = await f.post({ channelId: "2", content: "x" });
    assert.equal(result.status, errorStatuses[code]);
    assert.deepEqual(result.body, { code, message: "Safe description." });
  }
  f.operations.sendMessage = async () => { throw Object.assign(new Error(key), { requestBody: "private content", authorization: "discord-token" }); };
  const result = await f.post({ channelId: "2", content: "x" });
  assert.deepEqual(result.body, { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
  assert.equal(result.status, 500);
  assert.equal("RATE_LIMITED" in errorStatuses, false);
});

test("shutdown drains accepted sends, is idempotent and releases the port", async (t) => {
  const gate = deferred();
  let started = false;
  const f = await fixture(t, { sendMessage: async () => { started = true; await gate.promise; return { messageId: "3", channelId: "2", guildId: "1" }; } });
  const pending = f.post({ channelId: "2", content: "x" });
  await until(() => started);
  const stopping = f.api.stop();
  assert.equal(f.api.stop(), stopping);
  let finished = false;
  void stopping.then(() => finished = true);
  await nextTurn();
  assert.equal(finished, false);
  gate.resolve();
  assert.equal((await pending).status, 201);
  await stopping;
  assert.equal(f.api.address(), null);
  await assert.rejects(fetch(f.base + "/v1/info"));
});

test("bind failure and shutdown during listen leave no listening server", async (t) => {
  const f = await fixture(t);
  const second = new ControlApi({ enabled: true, host: "127.0.0.1", port: f.api.address().port, key }, fakeOperations(), createServiceInfo("dev"), () => "running");
  await assert.rejects(second.start(), { code: "EADDRINUSE" });
  await second.stop();
  assert.equal(second.address(), null);
  const third = new ControlApi({ enabled: true, host: "127.0.0.1", port: 0, key }, fakeOperations(), createServiceInfo("dev"), () => "starting");
  await Promise.all([third.start(), third.stop()]);
  assert.equal(third.address(), null);
});
