// Stays alive until Docker SIGTERM; never logs into Discord or reads deployment .env.
import Application from '../../dist/services/application.js';
import Bot from '../../dist/services/bot.js';
import ControlApi from '../../dist/services/controlApi.js';
import DiscordOperations from '../../dist/services/discordOperations.js';
import { createServiceInfo } from '../../dist/utils/runtimeVersion.js';
const app = new Application({ DISCORD_TOKEN: `MT${'x'.repeat(60)}`, DISCORD_CLIENT_ID: '1' }, { createRuntime: async (env, state, fatal) => { const bot = new Bot(), api = new ControlApi({ enabled: true, host: '0.0.0.0', port: 3100, key: 'fixture-control-key' }, new DiscordOperations(bot.client), createServiceInfo('shutdown-smoke'), state, fatal); return { start: () => api.start(), stop: async () => { await api.stop(); console.log('API_CLOSED'); await bot.destroy(); console.log('BOT_DESTROYED'); }, forceClose: () => { api.forceClose(); void bot.destroy(); } }; } });
await app.start(); console.log('READY_FOR_DOCKER_STOP');
