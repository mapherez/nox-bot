import Application from '../../dist/services/application.js';
const failure = Object.assign(new Error('expected failure'), { requestBody: 'PRIVATE_REQUEST_BODY' });
const app = new Application({ DISCORD_TOKEN: `MT${'x'.repeat(60)}`, DISCORD_CLIENT_ID: '1' }, { createRuntime: async () => ({ start: async () => { if (process.argv[2] === 'startup') throw failure; }, stop: async () => { console.log('API_CLOSED'); console.log('BOT_DESTROYED'); }, forceClose() {} }) });
try { await app.start(); if (process.argv[2] === 'uncaught') queueMicrotask(() => { throw failure; }); if (process.argv[2] === 'rejection') void Promise.reject(failure); } catch { process.exit(1); }
