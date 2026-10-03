// Run inside the production image with tests mounted at /app/tests; no Discord login or real tokens.
import assert from "node:assert/strict";
import Application from "../../dist/services/application.js";
import Bot from "../../dist/services/bot.js";
import ControlApi from "../../dist/services/controlApi.js";

const enabled = process.argv[2] === "enabled";
let bot, api, stopped;
const app = new Application({
  DISCORD_TOKEN: `MT${"x".repeat(60)}`, CLIENT_ID: "1",
  NOX_DISCORD_API_ENABLED: String(enabled), NOX_DISCORD_API_HOST: "127.0.0.1",
  NOX_DISCORD_API_KEY: "docker-smoke-control-key",
}, {
  createBot: (intents) => {
    bot = new Bot(intents);
    bot.login = async () => true;
    return bot;
  },
  createRegistrar: () => ({ registerCommands: async (commands) => {
    assert.ok(commands.some((command) => command.name === "nox"));
  } }),
  createApi: (config, operations, info, state, onFatal) => api = new ControlApi({ ...config, port: 0 }, operations, info, state, onFatal),
}, (code) => { stopped = code; });
await app.start();
assert.equal(app.getState(), "running");
assert.equal(bot.client.rest.options.rejectOnRateLimit, null);
if (enabled) {
  const base = `http://127.0.0.1:${api.address().port}`;
  const info = await (await fetch(base + "/v1/info")).json();
  const health = await fetch(base + "/v1/health");
  assert.equal(health.status, 503); // Real Client intentionally never logs in.
  assert.equal((await health.json()).version, info.version);
  assert.equal(info.version, "arm64-smoke");
  assert.equal((await fetch(base + "/v1/status")).status, 401);
} else assert.equal(api, undefined);
process.emit("SIGTERM");
await app.stop();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(stopped, 0);
assert.equal(bot.client.listenerCount("messageCreate"), 0);
if (api) assert.equal(api.address(), null);
console.log(`Docker smoke passed (${enabled ? "enabled" : "disabled"}).`);
