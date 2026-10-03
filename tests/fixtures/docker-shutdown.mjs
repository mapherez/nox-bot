// Offline process that stays alive until Docker sends SIGTERM. Never calls Discord login/REST.
import Application from "../../dist/services/application.js";
import Bot from "../../dist/services/bot.js";

const app = new Application({
  DISCORD_TOKEN: `MT${"x".repeat(60)}`, CLIENT_ID: "1",
  NOX_DISCORD_API_ENABLED: "true", NOX_DISCORD_API_HOST: "0.0.0.0",
  NOX_DISCORD_API_KEY: "docker-smoke-control-key",
}, {
  loadIntents: async () => [1], loadCommands: async () => [],
  createBot: (intents) => {
    const bot = new Bot(intents);
    bot.login = async () => true;
    return bot;
  },
  createHandler: () => ({ initialize: async () => {} }),
  createRegistrar: () => ({ registerCommands: async () => {} }),
});
await app.start();
console.log("READY_FOR_DOCKER_STOP");
