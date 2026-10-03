import Application from "../../dist/services/application.js";

const failure = Object.assign(new Error("expected failure"), { requestBody: "PRIVATE_REQUEST_BODY" });
const app = new Application({ DISCORD_TOKEN: `MT${"x".repeat(60)}`, CLIENT_ID: "1", NOX_DISCORD_API_ENABLED: "true", NOX_DISCORD_API_KEY: "test-key" }, {
  loadIntents: async () => [1], loadCommands: async () => [],
  createBot: () => ({ client: {}, setCommandHandler() {}, login: async () => true, destroy: async () => console.log("BOT_DESTROYED") }),
  createHandler: () => ({ initialize: async () => {} }),
  createRegistrar: () => ({ registerCommands: async () => { if (process.argv[2] === "startup") throw failure; } }),
  createOperations: () => ({}),
  createApi: () => ({ start: async () => {}, stop: async () => console.log("API_CLOSED"), forceClose() {} }),
});
try {
  await app.start();
  if (process.argv[2] === "uncaught") queueMicrotask(() => { throw failure; });
  if (process.argv[2] === "rejection") void Promise.reject(failure);
} catch { process.exit(1); }
