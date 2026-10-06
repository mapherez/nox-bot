// Offline smoke inside the production image: no actual Discord login or credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import Application from '../../dist/services/application.js';
import Bot from '../../dist/services/bot.js';
import DiscordOperations from '../../dist/services/discordOperations.js';
import ControlApi from '../../dist/services/controlApi.js';
import { loadControlApiConfig } from '../../dist/controlApi.js';
import { createServiceInfo } from '../../dist/utils/runtimeVersion.js';
import { DbConnection } from '../../dist/storage/bindings/index.js';
assert.equal(typeof DbConnection.builder, 'function');
const Native = createRequire(import.meta.url)('nodehun').Nodehun;
const dictionary = new Native(await readFile('/app/dist/assets/dictionaries/portuguese/pt_PT.aff'), await readFile('/app/dist/assets/dictionaries/portuguese/pt_PT.dic'));
assert.equal(await dictionary.spell('coração'), true);
const enabled = process.argv[2] === 'enabled'; let bot, api, exited;
const app = new Application({ DISCORD_TOKEN: `MT${'x'.repeat(60)}`, DISCORD_CLIENT_ID: '1', NOX_BOT_API_ENABLED: String(enabled), NOX_BOT_API_HOST: '127.0.0.1', NOX_BOT_API_KEY: 'fixture-control-key' }, { createRuntime: async (env, state, fatal) => {
  bot = new Bot(); const config = loadControlApiConfig(env); if (config.enabled) api = new ControlApi({ ...config, port: 0 }, new DiscordOperations(bot.client), createServiceInfo('smoke'), state, fatal);
  return { start: async () => { await api?.start(); }, stop: async () => { await api?.stop(); await bot.destroy(); }, forceClose: () => { api?.forceClose(); void bot.destroy(); } };
} }, code => { exited = code; });
await app.start(); assert.equal(app.getState(), 'running');
if (enabled) { const url = `http://127.0.0.1:${api.address().port}`; assert.equal((await fetch(`${url}/v1/health`)).status, 503); assert.equal((await fetch(`${url}/v1/status`)).status, 401); assert.equal((await (await fetch(`${url}/v1/info`)).json()).service, 'nox-bot'); } else assert.equal(api, undefined);
process.emit('SIGTERM'); await app.stop(); await new Promise(resolve => setImmediate(resolve)); assert.equal(exited, 0); assert.equal(bot.client.listenerCount('messageCreate'), 0); if (api) assert.equal(api.address(), null);
console.log(`Docker smoke passed: ${process.arch}, API ${enabled ? 'enabled' : 'disabled'}, native Dictionary and SDK loaded.`);
