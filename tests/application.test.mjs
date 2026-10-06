import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Application from '../dist/services/application.js';
import ControlApi from '../dist/services/controlApi.js';
import { env, key, fakeOperations, deferred, until, quietLogger } from './helpers.mjs';
quietLogger();
function fixture(overrides = {}, config = {}, timeout = 1000) {
  const events = [], exits = []; let stops = 0;
  const runtime = { start: async () => events.push('start'), stop: async () => { stops++; events.push('stop'); }, forceClose: () => events.push('force'), ...overrides };
  const app = new Application({ ...env, ...config }, { createRuntime: async (received, state, fatal) => { assert.equal(received.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_ID); events.push('create'); return runtime; } }, code => exits.push(code), timeout);
  return { app, events, exits, runtime, stops: () => stops };
}
test('startup loads confirmed runtime before becoming ready and stop is idempotent', async () => {
  const f = fixture(); await f.app.start(); assert.equal(f.app.getState(), 'running'); assert.deepEqual(f.events, ['create', 'start']);
  const stopping = f.app.stop(); assert.equal(f.app.stop(), stopping); await stopping; assert.equal(f.stops(), 1);
});
test('invalid environment fails before resources are created', async () => {
  const f = fixture({}, { DISCORD_TOKEN: '' }); await assert.rejects(f.app.start()); assert.deepEqual(f.events, []); assert.equal(f.app.getState(), 'stopping');
});
test('partial startup failures dispose runtime and remove all owned process listeners', async () => {
  const before = Object.fromEntries(['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map(event => [event, process.listenerCount(event)]));
  const f = fixture({ start: async () => { throw new Error('expected failure'); } }); await assert.rejects(f.app.start(), /expected failure/); assert.equal(f.stops(), 1);
  for (const [event, count] of Object.entries(before)) assert.equal(process.listenerCount(event), count);
});
test('shutdown during snapshot initialization prevents readiness after delayed startup completes', async () => {
  const gate = deferred(); let entered = false;
  const f = fixture({ start: async () => { entered = true; await gate.promise; } }); const starting = f.app.start(); await until(() => entered); await f.app.stop(); gate.resolve(); await starting; assert.equal(f.app.getState(), 'stopping'); assert.equal(f.stops(), 1);
});
test('shutdown while resource factory is pending closes resources that arrive later', async () => {
  const gate = deferred(); let stopped = 0, started = 0;
  const app = new Application(env, { createRuntime: () => gate.promise }, () => {}); const starting = app.start(); await app.stop(); gate.resolve({ start: async () => started++, stop: async () => stopped++, forceClose() {} }); await starting; assert.equal(started, 0); assert.equal(stopped, 1);
});
test('shutdown deadline force-closes stuck resources', async () => {
  const gate = deferred(), f = fixture({ stop: () => gate.promise }, {}, 20); await f.app.start(); await f.app.stop(); assert.ok(f.events.includes('force')); gate.resolve();
});
test('repeated signals produce one cleanup and one exit', async () => {
  const before = process.listenerCount('SIGTERM'), f = fixture(); await f.app.start(); process.emit('SIGTERM'); process.emit('SIGTERM'); await until(() => f.exits.length === 1); assert.deepEqual(f.exits, [0]); assert.equal(f.stops(), 1); assert.equal(process.listenerCount('SIGTERM'), before);
});
test('real Control API drains and closes before Discord destruction during interrupted startup', async () => {
  const gate = deferred(), events = []; let api, entered = false;
  const app = new Application(env, { createRuntime: async (received, state) => {
    api = new ControlApi({ enabled: true, host: '127.0.0.1', port: 0, key }, fakeOperations(), { service: 'nox-bot', version: 'test', apiVersion: 'v1', capabilities: [] }, state, () => {});
    return { start: async () => { await api.start(); entered = true; await gate.promise; }, stop: async () => { await api.stop(); events.push('close', 'destroy'); }, forceClose: () => api.forceClose() };
  } }, () => {});
  const starting = app.start(); await until(() => entered); assert.equal((await fetch(`http://127.0.0.1:${api.address().port}/v1/health`)).status, 503); await app.stop(); gate.resolve(); await starting; assert.equal(api.address(), null); assert.deepEqual(events, ['close', 'destroy']);
});
test('fatal errors use cleanup without leaking promises or request metadata', () => {
  for (const mode of ['uncaught', 'rejection', 'startup']) { const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/fatal.mjs', import.meta.url)), mode], { encoding: 'utf8', timeout: 15000 }); assert.equal(child.status, 1, child.stderr); assert.ok(child.stdout.includes('API_CLOSED')); assert.ok(child.stdout.includes('BOT_DESTROYED')); assert.equal((child.stdout + child.stderr).includes('PRIVATE_REQUEST_BODY'), false); }
});
