import test from 'node:test';
import assert from 'node:assert/strict';
import Bot from '../dist/services/bot.js';
import { until, quietLogger } from './helpers.mjs';
quietLogger();
test('interaction routing and shutdown preserve external listeners', async () => {
  const bot = new Bot([1, 512, 32768]), calls = []; bot.attach({ handle: async value => calls.push(value), close() {} }, {}, {});
  const interaction = {}; bot.client.emit('interactionCreate', interaction); await until(() => calls.length === 1); assert.deepEqual(calls, [interaction]);
  const external = () => {}; bot.client.on('messageCreate', external); const stopping = bot.destroy(); assert.equal(bot.destroy(), stopping); await stopping; assert.deepEqual(bot.client.listeners('messageCreate'), [external]); assert.equal(bot.client.listenerCount('interactionCreate'), 0); assert.equal(bot.client.listenerCount('clientReady'), 0); bot.client.off('messageCreate', external);
});
test('Quick Commands are case insensitive, guild scoped, public and send even when cleanup fails', async t => {
  const bot = new Bot([1, 512, 32768]); t.after(() => bot.destroy()); const calls = [];
  bot.attach({ handle: async () => {}, close() {} }, { response: (guild, trigger) => guild === '1' && trigger === 'test' ? 'original response' : undefined, list: guild => guild === '1' ? [{ data: { trigger: 'test' } }, { data: { trigger: 'zed' } }] : [] }, { send: async (target, content) => calls.push({ target, content }) });
  const message = { guildId: '1', channelId: '2', author: { bot: false }, content: '!TEST ignored arguments', delete: async () => { calls.push('delete'); throw new Error('No permission'); } };
  bot.client.emit('messageCreate', message); await until(() => calls.length === 2); assert.equal(calls[1].content.content, 'original response'); assert.deepEqual(calls[1].target, { provider: 'discord', kind: 'guild-channel', guildId: '1', channelId: '2' });
  calls.length = 0; bot.client.emit('messageCreate', { ...message, content: '!help' }); await until(() => calls.length === 2); assert.equal(calls[1].content.content, '!test, !zed');
  calls.length = 0; bot.client.emit('messageCreate', { ...message, guildId: '2' }); bot.client.emit('messageCreate', { ...message, author: { bot: true } }); bot.client.emit('messageCreate', { ...message, guildId: null }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, []); assert.equal(bot.client.rest.options.rejectOnRateLimit, null);
});
