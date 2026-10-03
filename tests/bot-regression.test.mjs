import test from "node:test";
import assert from "node:assert/strict";
import { Routes, SlashCommandBuilder } from "discord.js";
import Bot from "../dist/services/bot.js";
import CommandHandler from "../dist/services/commandHandler.js";
import CommandRegistrar from "../dist/services/commandRegistrar.js";
import { quietLogger } from "./helpers.mjs";

quietLogger();

test("slash interaction routing remains intact and shutdown removes only owned listeners", async () => {
  const bot = new Bot([1, 512, 32768]);
  const calls = [];
  const handler = new CommandHandler();
  handler.commands.set("test", { execute: async (interaction) => calls.push(interaction) });
  bot.setCommandHandler(handler);
  const interaction = { isButton: () => false, isChatInputCommand: () => true, commandName: "test" };
  await bot.client.listeners("interactionCreate")[0](interaction);
  assert.deepEqual(calls, [interaction]);
  const external = () => {};
  bot.client.on("messageCreate", external);
  const stopping = bot.destroy();
  assert.equal(bot.destroy(), stopping);
  await stopping;
  assert.deepEqual(bot.client.listeners("messageCreate"), [external]);
  assert.equal(bot.client.listenerCount("interactionCreate"), 0);
  assert.equal(bot.client.listenerCount("clientReady"), 0);
  bot.client.off("messageCreate", external);
});

test("prefix commands still delete input, send a normal message and ignore bot messages", async (t) => {
  const bot = new Bot([1, 512, 32768]);
  t.after(() => bot.destroy());
  bot.prefixCommands = { test: "original response", zed: "last" };
  const calls = [];
  const message = { author: { bot: false }, content: "!TEST argument", delete: async () => calls.push("delete"), channel: { send: async (content) => calls.push(content) } };
  const handle = bot.client.listeners("messageCreate")[0];
  await handle(message);
  assert.deepEqual(calls, ["delete", "original response"]);
  calls.length = 0;
  await handle({ ...message, content: "!help" });
  assert.deepEqual(calls, ["delete", "Available commands:\n!test, !zed"]);
  calls.length = 0;
  await handle({ ...message, author: { bot: true } });
  assert.deepEqual(calls, []);
  assert.equal(bot.client.rest.options.rejectOnRateLimit, null);
});

test("registration remains development-guild or global with the existing REST service", async () => {
  const command = new SlashCommandBuilder().setName("test").setDescription("test");
  for (const guilds of [[], ["8", "9"]]) {
    const registrar = new CommandRegistrar("fake-discord-token", "7", guilds);
    const calls = [];
    registrar.rest.put = async (...args) => calls.push(args);
    await registrar.registerCommands([command]);
    assert.deepEqual(calls.map(([route]) => route), guilds.length ? guilds.map((id) => Routes.applicationGuildCommands("7", id)) : [Routes.applicationCommands("7")]);
    assert.deepEqual(calls[0][1], { body: [command] });
  }
});
