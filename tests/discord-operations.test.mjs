import test from "node:test";
import assert from "node:assert/strict";
import { Client, ClientUser, Guild, GuildMember, TextChannel, ChannelType, DiscordAPIError, HTTPError, PermissionFlagsBits as P, PermissionsBitField, Status } from "discord.js";
import DiscordOperations, { translateDiscordError } from "../dist/services/discordOperations.js";

function fixture() {
  const member = { isCommunicationDisabled: () => false };
  const channels = new Map();
  const guild = { id: "1", name: "Guild", available: true, channels: { fetch: async () => channels }, members: { me: member, fetchMe: async () => member } };
  const client = {
    isReady: () => true,
    ws: { status: Status.Ready, ping: 42 },
    user: { id: "7", username: "NoX", token: "must-not-appear" },
    guilds: { cache: new Map([["1", guild]]) },
    channels: { fetch: async (id) => channels.get(id) ?? null },
  };
  const add = (id, type = ChannelType.GuildText, permissions = [P.ViewChannel, P.SendMessages]) => {
    const channel = { id, name: `channel-${id}`, type, guildId: "1", permissionsFor: () => new PermissionsBitField(permissions), send: async () => ({ id: "3", channelId: id }) };
    channels.set(id, channel);
    return channel;
  };
  return { client, guild, member, channels, add, operations: new DiscordOperations(client) };
}

test("status DTO maps connection states and never serializes client objects", () => {
  const f = fixture();
  assert.deepEqual(f.operations.getStatus(), { discord: { state: "connected", ready: true, pingMs: 42 }, bot: { id: "7", username: "NoX" }, guildCount: 1 });
  f.client.isReady = () => false;
  for (const [status, state] of [[Status.Connecting, "connecting"], [Status.Identifying, "connecting"], [Status.WaitingForGuilds, "connecting"], [Status.Resuming, "reconnecting"], [Status.Reconnecting, "reconnecting"], [Status.Disconnected, "disconnected"], [Status.Idle, "disconnected"]]) {
    f.client.ws.status = status;
    assert.deepEqual(f.operations.getStatus().discord, { state, ready: false, pingMs: null });
  }
  f.client.user = null;
  assert.equal(f.operations.getStatus().bot, null);
  f.client.isReady = () => true;
  for (const ping of [-1, NaN, Infinity]) {
    f.client.ws.ping = ping;
    assert.equal(f.operations.getStatus().discord.pingMs, null);
  }
});

test("guilds are minimal, deterministic and unavailable when Discord is disconnected", async () => {
  const f = fixture();
  f.client.guilds.cache.set("4", { id: "4", name: "Other", secret: "private" });
  assert.deepEqual(await f.operations.listGuilds(), [{ id: "1", name: "Guild" }, { id: "4", name: "Other" }]);
  f.client.isReady = () => false;
  await assert.rejects(f.operations.listGuilds(), { code: "DISCORD_UNAVAILABLE" });
});

test("channel listing fetches REST data and excludes unsupported or unwritable channels", async () => {
  const f = fixture();
  let fetched = 0, memberFetched = 0;
  f.guild.channels.fetch = async () => { fetched++; return f.channels; };
  f.guild.members.me = null;
  f.guild.members.fetchMe = async () => { memberFetched++; return f.member; };
  f.add("9", ChannelType.GuildAnnouncement);
  f.add("2");
  f.add("3", ChannelType.GuildText, [P.SendMessages]);
  f.add("4", ChannelType.GuildText, [P.ViewChannel]);
  for (const [index, type] of [ChannelType.DM, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.GuildCategory].entries()) f.add(String(index + 20), type);
  f.channels.set("50", null);
  assert.deepEqual(await f.operations.listChannels("1"), [{ id: "2", name: "channel-2", type: "text" }, { id: "9", name: "channel-9", type: "announcement" }]);
  assert.equal(fetched, 1);
  assert.equal(memberFetched, 1);
  f.member.isCommunicationDisabled = () => true;
  assert.deepEqual(await f.operations.listChannels("1"), []);
  f.add("60", ChannelType.GuildText, [P.Administrator]);
  assert.deepEqual((await f.operations.listChannels("1")).map((channel) => channel.id), ["60"]);
});

test("real discord.js permission overwrites are respected by list and send", async (t) => {
  const client = new Client({ intents: [1] });
  t.after(() => client.destroy());
  client.user = new ClientUser(client, { id: "7", username: "NoX" });
  const guild = new Guild(client, {
    id: "1", name: "Guild", unavailable: false, owner_id: "99", channels: [],
    roles: [{ id: "1", name: "@everyone", permissions: (P.ViewChannel | P.SendMessages).toString() }],
  });
  client.guilds.cache.set("1", guild);
  const member = new GuildMember(client, { user: { id: "7", username: "NoX" }, roles: [] }, guild);
  guild.members.cache.set("7", member);
  const denied = new TextChannel(guild, { id: "2", name: "denied", type: ChannelType.GuildText, permission_overwrites: [{ id: "1", type: 0, deny: P.SendMessages.toString(), allow: "0" }] }, client);
  const allowed = new TextChannel(guild, { id: "4", name: "allowed", type: ChannelType.GuildText, permission_overwrites: [{ id: "1", type: 0, deny: P.SendMessages.toString(), allow: "0" }, { id: "7", type: 1, deny: "0", allow: P.SendMessages.toString() }] }, client);
  guild.channels.fetch = async () => new Map([["2", denied], ["4", allowed]]);
  client.channels.fetch = async () => denied;
  client.isReady = () => true;
  const operations = new DiscordOperations(client);
  assert.deepEqual(await operations.listChannels("1"), [{ id: "4", name: "allowed", type: "text" }]);
  await assert.rejects(operations.sendMessage("2", "x"), { code: "INSUFFICIENT_PERMISSIONS" });
});

test("sending uses a fresh channel, current permissions and the unchanged content", async () => {
  const f = fixture();
  const channel = f.add("2", ChannelType.GuildAnnouncement);
  let options, sent;
  f.client.channels.fetch = async (id, args) => { assert.equal(id, "2"); options = args; return channel; };
  channel.send = async (args) => { sent = args; return { id: "3", channelId: "2" }; };
  const content = " \n@everyone <@7> original\t ";
  assert.deepEqual(await f.operations.sendMessage("2", content), { messageId: "3", channelId: "2", guildId: "1" });
  assert.deepEqual(options, { force: true });
  assert.deepEqual(sent, { content });
  channel.permissionsFor = () => new PermissionsBitField([P.ViewChannel]);
  await assert.rejects(f.operations.sendMessage("2", "x"), { code: "INSUFFICIENT_PERMISSIONS" });
  f.client.channels.fetch = async () => null;
  await assert.rejects(f.operations.sendMessage("2", "x"), { code: "CHANNEL_NOT_FOUND" });
});

test("unsupported channels, invalid payloads and absent/unavailable guilds reject without send", async () => {
  const f = fixture();
  for (const type of [ChannelType.DM, ChannelType.PublicThread, ChannelType.GuildForum, ChannelType.GuildVoice]) {
    f.add("2", type);
    await assert.rejects(f.operations.sendMessage("2", "x"), { code: "INVALID_CHANNEL" });
  }
  f.add("2");
  for (const content of ["", " \t\n ", "x".repeat(2001)]) await assert.rejects(f.operations.sendMessage("2", content), { code: "INVALID_PAYLOAD" });
  await assert.rejects(f.operations.listChannels("bad"), { code: "INVALID_PAYLOAD" });
  await assert.rejects(f.operations.listChannels("8"), { code: "GUILD_NOT_FOUND" });
  f.guild.available = false;
  await assert.rejects(f.operations.listChannels("1"), { code: "DISCORD_UNAVAILABLE" });
  await assert.rejects(f.operations.sendMessage("2", "x"), { code: "DISCORD_UNAVAILABLE" });
  f.guild.available = true;
  f.guild.members.me = null;
  f.guild.members.fetchMe = async () => { f.client.isReady = () => false; return f.member; };
  await assert.rejects(f.operations.sendMessage("2", "x"), { code: "DISCORD_UNAVAILABLE" });
});

test("only known upstream errors are translated and private metadata is discarded", async () => {
  const f = fixture();
  const channel = f.add("2");
  for (const [code, expected] of [[10003, "CHANNEL_NOT_FOUND"], [10004, "GUILD_NOT_FOUND"], [50001, "INSUFFICIENT_PERMISSIONS"], [50013, "INSUFFICIENT_PERMISSIONS"], [50035, "INVALID_PAYLOAD"], [200000, "MESSAGE_REJECTED"]]) {
    channel.send = async () => { throw new DiscordAPIError({ message: "private" }, code, 400, "POST", "private-url", { body: { authorization: "private", content: "private" } }); };
    await assert.rejects(f.operations.sendMessage("2", "x"), (error) => error.code === expected && !JSON.stringify(error).includes("private"));
  }
  assert.equal(translateDiscordError(new HTTPError(503, "private", "POST", "private-url", { body: {} })).code, "DISCORD_UNAVAILABLE");
  assert.equal(translateDiscordError(Object.assign(new Error("private"), { code: "ECONNRESET" })).code, "DISCORD_UNAVAILABLE");
  assert.equal(translateDiscordError(new Error("private")).code, "INTERNAL_ERROR");
});

test("real client retains the library's internal rate-limit handling", async () => {
  const client = new Client({ intents: [1] });
  try { assert.equal(client.rest.options.rejectOnRateLimit, null); }
  finally { await client.destroy(); }
});
