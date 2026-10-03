import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Application from "../dist/services/application.js";
import ControlApi from "../dist/services/controlApi.js";
import { env, key, fakeOperations, deferred, until, quietLogger } from "./helpers.mjs";

quietLogger();

function fixture(overrides = {}, config = {}, timeout = 1000) {
  const events = [];
  const exits = [];
  let botDestroyed = 0;
  const bot = { client: {}, setCommandHandler: () => events.push("attach"), login: async () => { events.push("login"); return true; }, destroy: async () => { botDestroyed++; events.push("destroy"); } };
  const api = { start: async () => events.push("listen"), stop: async () => events.push("close"), forceClose: () => events.push("force") };
  const dependencies = {
    loadIntents: async () => { events.push("intents"); return [1]; },
    loadCommands: async () => { events.push("commands"); return ["command"]; },
    createBot: () => { events.push("bot"); return bot; },
    createHandler: () => ({ initialize: async () => events.push("initialize") }),
    createRegistrar: (token, id, guilds) => { events.push(["registrar", token, id, guilds]); return { registerCommands: async () => events.push("register") }; },
    createOperations: (value) => { assert.equal(value, bot); return fakeOperations(); },
    createApi: () => api,
    ...overrides,
  };
  const app = new Application({ ...env, NOX_DISCORD_API_ENABLED: "true", NOX_DISCORD_API_KEY: key, ...config }, dependencies, (code) => exits.push(code), timeout);
  return { app, events, exits, bot, api, destroyed: () => botDestroyed };
}

test("startup preserves registration/login order and opt-in API uses the same bot", async () => {
  const f = fixture({}, { GUILD_ID: "8" });
  await f.app.start();
  assert.equal(f.app.getState(), "running");
  assert.deepEqual(f.events, ["intents", "bot", "listen", "commands", "initialize", ["registrar", env.DISCORD_TOKEN, env.CLIENT_ID, ["8"]], "attach", "register", "login"]);
  const stopping = f.app.stop();
  assert.equal(f.app.stop(), stopping);
  await stopping;
  assert.deepEqual(f.events.slice(-2), ["close", "destroy"]);
  assert.equal(f.destroyed(), 1);
  const off = fixture({ createApi: () => { throw new Error("API must not be created"); }, createOperations: () => { throw new Error("API operations must not be created"); } }, { NOX_DISCORD_API_ENABLED: "false", NOX_DISCORD_API_KEY: "" });
  await off.app.start();
  assert.deepEqual(off.events.find(Array.isArray).at(-1), []);
  await off.app.stop();
});

test("invalid environment/API configuration fails before creating resources or registering", async () => {
  for (const overrides of [{ DISCORD_TOKEN: "" }, { NOX_DISCORD_API_KEY: "" }, { NOX_DISCORD_API_KEY: env.DISCORD_TOKEN }, { NOX_DISCORD_API_PORT: "bad" }]) {
    const f = fixture({}, overrides);
    await assert.rejects(f.app.start());
    assert.deepEqual(f.events, []);
    assert.equal(f.app.getState(), "stopping");
  }
});

test("bind, command initialization, registration and login failures clean partial resources", async () => {
  const baseline = Object.fromEntries(["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].map((event) => [event, process.listenerCount(event)]));
  const fail = async () => { throw new Error("expected failure"); };
  for (const stage of ["listen", "commands", "initialize", "register", "login"]) {
    const overrides = stage === "commands" ? { loadCommands: fail } :
      stage === "initialize" ? { createHandler: () => ({ initialize: fail }) } :
      stage === "register" ? { createRegistrar: () => ({ registerCommands: fail }) } : {};
    const f = fixture(overrides);
    if (stage === "listen") f.api.start = fail;
    if (stage === "login") f.bot.login = fail;
    await assert.rejects(f.app.start(), /expected failure/);
    assert.equal(f.app.getState(), "stopping");
    for (const [event, count] of Object.entries(baseline)) assert.equal(process.listenerCount(event), count);
    assert.equal(f.destroyed(), 1);
    assert.ok(f.events.includes("close"));
  }
});

test("shutdown at asynchronous startup boundaries prevents continuation", async () => {
  for (const stage of ["intents", "commands", "initialize", "register", "login"]) {
    const gate = deferred();
    let reached = false;
    const pause = async () => { reached = true; await gate.promise; return stage === "intents" ? [1] : []; };
    const overrides = stage === "intents" ? { loadIntents: pause } : stage === "commands" ? { loadCommands: pause } :
      stage === "initialize" ? { createHandler: () => ({ initialize: pause }) } :
      stage === "register" ? { createRegistrar: () => ({ registerCommands: pause }) } : {};
    const f = fixture(overrides);
    if (stage === "login") f.bot.login = pause;
    const starting = f.app.start();
    await until(() => reached);
    await f.app.stop();
    const events = [...f.events];
    gate.resolve();
    await starting;
    assert.deepEqual(f.events, events);
    assert.equal(f.app.getState(), "stopping");
    assert.equal(f.destroyed(), stage === "intents" ? 0 : 1);
  }
});

test("shutdown drains HTTP before destroying Discord and bounds stuck cleanup", async () => {
  const gate = deferred();
  const f = fixture();
  f.api.stop = async () => { f.events.push("close"); await gate.promise; };
  await f.app.start();
  const stopping = f.app.stop();
  assert.equal(f.destroyed(), 0);
  gate.resolve();
  await stopping;
  assert.equal(f.destroyed(), 1);
  const stuck = deferred();
  const bounded = fixture({}, {}, 20);
  bounded.api.stop = () => stuck.promise;
  await bounded.app.start();
  await bounded.app.stop();
  await until(() => bounded.destroyed() === 1);
  assert.ok(bounded.events.includes("force"));
  stuck.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bounded.destroyed(), 1);
});

test("repeated signals produce one cleanup and remove process listeners", async () => {
  const baseline = process.listenerCount("SIGTERM");
  const f = fixture();
  await f.app.start();
  process.emit("SIGTERM");
  process.emit("SIGTERM");
  await until(() => f.exits.length === 1);
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.destroyed(), 1);
  assert.equal(process.listenerCount("SIGTERM"), baseline);
});

test("real HTTP lifecycle closes the listener if shutdown starts during registration", async () => {
  const gate = deferred();
  let entered = false, api;
  const f = fixture({
    createApi: (config, operations, info, state, onFatal) => api = new ControlApi({ ...config, port: 0 }, operations, info, state, onFatal),
    createRegistrar: () => ({ registerCommands: async () => { entered = true; await gate.promise; } }),
  });
  const starting = f.app.start();
  await until(() => entered);
  const url = `http://127.0.0.1:${api.address().port}/v1/health`;
  assert.equal((await fetch(url)).status, 503);
  await f.app.stop();
  gate.resolve();
  await starting;
  assert.equal(api.address(), null);
  assert.equal(f.events.includes("login"), false);
});

test("fatal errors use cleanup rather than dumping promises or REST metadata", () => {
  for (const mode of ["uncaught", "rejection", "startup"]) {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/fatal.mjs", import.meta.url)), mode], { encoding: "utf8", timeout: 15000 });
    assert.equal(child.status, 1, child.stderr);
    assert.ok(child.stdout.includes("API_CLOSED"));
    assert.ok(child.stdout.includes("BOT_DESTROYED"));
    assert.equal((child.stdout + child.stderr).includes("PRIVATE_REQUEST_BODY"), false);
  }
});
