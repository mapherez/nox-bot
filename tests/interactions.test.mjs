import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { InteractionRouter } from "../dist/services/interactionRouter.js";
import { CommandRegistry } from "../dist/core/commandRegistry.js";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { memoryState } from "./fixtures/state.mjs";
import { quietLogger } from "./helpers.mjs";
quietLogger();
function interaction(commandName = "ping", overrides = {}) {
  const calls = [],
    user = {
      id: "7",
      username: "Tester",
      createdTimestamp: 100,
      displayAvatarURL: () => "https://example.com/avatar.png",
    };
  const value = {
    calls,
    user,
    guildId: "1",
    channelId: "8",
    createdTimestamp: Date.now() - 10,
    commandName,
    options: { data: [], getSubcommand: () => "commands" },
    isChatInputCommand: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isAutocomplete: () => false,
    deferred: false,
    replied: false,
    reply: async (payload) => {
      value.replied = true;
      calls.push(["reply", payload]);
    },
    deferReply: async (payload) => {
      value.deferred = true;
      calls.push(["defer", payload]);
    },
    editReply: async (payload) => calls.push(["edit", payload]),
    followUp: async (payload) => calls.push(["followUp", payload]),
    update: async (payload) => calls.push(["update", payload]),
    deferUpdate: async () => {
      value.deferred = true;
      calls.push(["deferUpdate"]);
    },
    ...overrides,
  };
  return value;
}
test("top-level plugin interactions defer privately and remain operational with cached state while DB is unavailable", async (t) => {
  const f = await memoryState(t);
  await f.plugins.setEnabled("ping", "1", true, "0");
  const client = { guilds: { cache: new Map([["1", {}]]) } },
    sent = [];
  const router = new InteractionRouter(
    client,
    new CommandRegistry(f.plugins),
    f.plugins,
    new QuickCommandService(f.state),
    { send: async (...args) => sent.push(args) },
  );
  t.after(() => router.close());
  f.disconnect();
  const event = interaction();
  await router.handle(event);
  assert.equal(event.calls[0][0], "defer");
  assert.equal(event.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.equal(event.calls[1][0], "edit");
  assert.match(event.calls[1][1].content, /Pong/);
  assert.deepEqual(sent, []);
  const other = interaction("ping", { guildId: "2" });
  await router.handle(other);
  assert.equal(other.calls[0][1].flags, MessageFlags.Ephemeral);
});
test("Quick Command menu is private, paginated and owner-bound; selection sends publicly through Core", async (t) => {
  const f = await memoryState(t),
    quick = new QuickCommandService(f.state),
    sent = [];
  for (let index = 0; index < 23; index++)
    await quick.save(
      "1",
      {
        guildId: "1",
        trigger: `cmd${String(index).padStart(2, "0")}`,
        response: `Response ${index}`,
        enabled: true,
      },
      "0",
    );
  const router = new InteractionRouter(
    {
      guilds: {
        cache: new Map([
          ["1", {}],
          ["2", {}],
        ]),
      },
    },
    new CommandRegistry(f.plugins),
    f.plugins,
    quick,
    { send: async (...args) => sent.push(args) },
  );
  t.after(() => router.close());
  const menu = interaction("nox");
  await router.handle(menu);
  const payload = menu.calls[0][1];
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.equal(payload.components.length, 5);
  const first = payload.components[0].components[0].data.custom_id,
    next = payload.components[4].components[1].data.custom_id;
  const component = interaction("", {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: first,
  });
  await router.handle(component);
  assert.equal(component.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].content, "Response 0");
  const stranger = interaction("", {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: first,
    user: { id: "9" },
  });
  await router.handle(stranger);
  assert.match(stranger.calls[0][1].content, /another user/);
  assert.equal(sent.length, 1);
  const guildMismatch = interaction("", {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: first,
    guildId: "2",
  });
  await router.handle(guildMismatch);
  assert.match(guildMismatch.calls[0][1].content, /another user/);
  const page = interaction("", {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: next,
  });
  await router.handle(page);
  assert.equal(page.calls[0][0], "update");
  assert.equal(page.calls[0][1].components[0].components.length, 3);
  await quick.delete("1", "cmd00", f.state.get("quick", "1", "cmd00").revision);
  const stale = interaction("", {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: first,
  });
  await router.handle(stale);
  assert.match(stale.calls[0][1].content, /no longer enabled/);
  router.close();
  const expired = interaction("", {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId: next,
  });
  await router.handle(expired);
  assert.match(expired.calls[0][1].content, /expired/);
});
