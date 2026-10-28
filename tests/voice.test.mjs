import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import opus from "@discordjs/opus";
import { generateDependencyReport } from "@discordjs/voice";
import WebSocket, { WebSocketServer } from "ws";
import {
  DiscordDownsampler,
  DiscordUpsampler,
  FRAME_BYTES,
  FRAME_SAMPLES,
  InputMixer,
} from "../dist/voice/audio.js";
import { EngineAudio } from "../dist/voice/stream.js";
import { VoiceService, validateVoiceSettings } from "../dist/voice/service.js";
import { VoiceController } from "../dist/voice/controller.js";
import { CommandRegistry } from "../dist/core/commandRegistry.js";
import { memoryState } from "./fixtures/state.mjs";
import { quietLogger } from "./helpers.mjs";
quietLogger();
const settings = { voice: "NATF0", prompt: "Test persona", bits: 4 };
function fixture() {
  const engine = {
    state: "ready",
    phase: "Ready",
    error: null,
    conversationActive: false,
    settingsChanging: false,
    memoryBytes: 0,
    uptimeSeconds: 0,
  };
  let current = { ...settings };
  const calls = [],
    sessions = [];
  const controller = {
    async status() {
      return { ...engine };
    },
    async settings() {
      return { ...current };
    },
    async update(value) {
      assert.equal(engine.conversationActive, false);
      calls.push("update");
      current = { ...value };
      return current;
    },
    async action(action) {
      calls.push(action);
      engine.state = action === "stop" ? "stopped" : "starting";
      return { ...engine };
    },
    async diagnostics() {
      return { controller: "ready", missingFiles: [], engine };
    },
    async connect() {
      calls.push("connect");
      return {
        terminate() {
          calls.push("terminate");
        },
      };
    },
  };
  const discord = {
    async channels() {
      return [{ id: "10", name: "Voice" }];
    },
    async validate(guildId, channelId) {
      if (channelId === "999") throw new Error("No permission");
    },
    async join(guildId, channelId, fail) {
      calls.push(`join:${channelId}`);
      const conversation = {
        guildId,
        channelId,
        fail,
        closed: false,
        async open() {
          calls.push("audio");
          engine.conversationActive = true;
        },
        closeAudio() {
          calls.push("closeAudio");
          engine.conversationActive = false;
        },
        close() {
          calls.push("leave");
          this.closed = true;
          this.closeAudio();
        },
      };
      sessions.push(conversation);
      return conversation;
    },
  };
  const voice = new VoiceService(controller, discord);
  return { voice, engine, controller, discord, calls, sessions };
}
test("silence has the exact Float32LE engine frame contract; mixing clips safely and stays bounded", () => {
  const mixer = new InputMixer();
  assert.deepEqual(mixer.frame(0), Buffer.alloc(FRAME_BYTES));
  mixer.push("a", new Float32Array(FRAME_SAMPLES * 10).fill(0.75), 0);
  mixer.push("b", new Float32Array(FRAME_SAMPLES).fill(0.75), 0);
  assert.equal(mixer.frame(0).readFloatLE(0), 1);
  assert.equal(mixer.frame(80).readFloatLE(0), 0.75);
  assert.equal(mixer.frame(160).readFloatLE(0), 0.75);
  assert.deepEqual(mixer.frame(240), Buffer.alloc(FRAME_BYTES));
  mixer.push("a", new Float32Array([NaN, Infinity, 0.5]), 0);
  assert.deepEqual(mixer.frame(1000), Buffer.alloc(FRAME_BYTES));
});
test("streaming resampling preserves packet boundaries, channel mix and finite clipped output", () => {
  const pcm = Buffer.alloc(3840);
  for (let i = 0; i < pcm.length; i += 4) {
    pcm.writeInt16LE(16384, i);
    pcm.writeInt16LE(16384, i + 2);
  }
  const converter = new DiscordDownsampler();
  const small = new Float32Array([
    ...converter.convert(pcm),
    ...converter.convert(pcm),
  ]);
  assert.deepEqual(
    small,
    new DiscordDownsampler().convert(Buffer.concat([pcm, pcm])),
  );
  assert.equal(small.length, 960);
  assert.ok(Math.abs(small.at(-1) - 0.5) < 0.001);
  assert.equal(
    new DiscordUpsampler().convert(Buffer.alloc(FRAME_BYTES)).length,
    15360,
  );
  const frame = Buffer.alloc(FRAME_BYTES);
  frame.writeFloatLE(NaN, 0);
  frame.writeFloatLE(5, 4);
  const result = new DiscordUpsampler().convert(frame);
  assert.equal(result.readInt16LE(0), 0);
  assert.equal(result.readInt16LE(12), 32767);
  assert.throws(() => converter.convert(Buffer.alloc(3)));
});
test("native Opus roundtrip and DAVE dependency load without contacting Discord", () => {
  const codec = new opus.OpusEncoder(48000, 2);
  assert.equal(codec.decode(codec.encode(Buffer.alloc(3840))).length, 3840);
  assert.match(generateDependencyReport(), /@snazzah\/davey: 0\.1\./);
});
async function socketPair(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const connected = once(server, "connection");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => client.terminate());
  await once(client, "open");
  return { client, remote: (await connected)[0] };
}
test("real WebSocket pumps silent input every 80 ms and decodes each service audio frame into four Opus packets", async (t) => {
  const { client, remote } = await socketPair(t);
  const frames = [],
    times = [],
    packets = [];
  remote.on("message", (data) => {
    frames.push(Buffer.from(data));
    times.push(performance.now());
    remote.send(data);
  });
  let failures = 0;
  const audio = new EngineAudio(
    client,
    () => Buffer.alloc(FRAME_BYTES),
    () => failures++,
  );
  audio.output.on("data", (packet) => packets.push(packet));
  t.after(() => audio.close());
  await audio.start();
  await new Promise((resolve) => setTimeout(resolve, 210));
  audio.close();
  assert.ok(frames.length >= 3);
  assert.ok(times[1] - times[0] >= 45 && times[1] - times[0] < 180);
  for (const frame of frames)
    assert.deepEqual(frame, Buffer.alloc(FRAME_BYTES));
  assert.equal(packets.length, frames.length * 4);
  const decoder = new opus.OpusEncoder(48000, 2);
  for (const packet of packets)
    assert.equal(decoder.decode(packet).length, 3840);
  assert.equal(failures, 0);
});
test("closing during initial audio handshake rejects pending work; malformed service audio frames fail closed", async (t) => {
  const { client, remote } = await socketPair(t);
  const audio = new EngineAudio(
    client,
    () => Buffer.alloc(FRAME_BYTES),
    () => {},
  );
  const pending = audio.start();
  audio.close();
  await assert.rejects(pending, /closed/);
  const second = await socketPair(t);
  let failures = 0;
  const bad = new EngineAudio(
    second.client,
    () => Buffer.alloc(FRAME_BYTES),
    () => failures++,
  );
  const response = bad.start();
  second.remote.send(Buffer.alloc(5));
  await assert.rejects(response);
  assert.equal(failures, 1);
});
test("a slow Discord consumer cannot grow the service output queue indefinitely", async (t) => {
  const { client, remote } = await socketPair(t);
  let failures = 0;
  const audio = new EngineAudio(
    client,
    () => Buffer.alloc(FRAME_BYTES),
    () => failures++,
  );
  const started = audio.start();
  for (let i = 0; i < 12; i++) remote.send(Buffer.alloc(FRAME_BYTES));
  await started.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(failures, 1);
  assert.ok(audio.output.writableLength <= 12);
});
test("voice requires an already ready and free engine and never starts it implicitly", async () => {
  const f = fixture();
  f.engine.state = "stopped";
  await assert.rejects(
    f.voice.enable("1", { channelId: "10" }),
    /Start the engine/,
  );
  f.engine.state = "ready";
  f.engine.conversationActive = true;
  await assert.rejects(
    f.voice.enable("1", { channelId: "10" }),
    /another conversation/,
  );
  assert.deepEqual(f.calls, []);
  await f.voice.close();
});
test("disabling leaves the voice service running, empty-channel/no updates preserves session, failures require explicit enable", async () => {
  const f = fixture();
  await f.voice.enable("1", { channelId: "10" });
  await f.voice.synchronize(new Map([["1", { channelId: "10" }]]));
  assert.equal(f.sessions.length, 1);
  assert.equal(f.voice.isActive("1"), true);
  await f.voice.disable("1");
  assert.equal(f.engine.state, "ready");
  assert.equal(f.engine.conversationActive, false);
  await f.voice.enable("1", { channelId: "10" });
  f.sessions.at(-1).fail();
  await f.voice.synchronize(new Map([["1", { channelId: "10" }]]));
  assert.equal(f.voice.isActive("1"), false);
  assert.equal(f.sessions.length, 2);
  await f.voice.enable("1", { channelId: "10" });
  assert.equal(f.sessions.length, 3);
  await f.voice.close();
});
test("settings share controller state and reset only the audio conversation while staying in Discord", async () => {
  const f = fixture();
  await f.voice.enable("1", { channelId: "10" });
  const changed = {
    ...settings,
    voice: "NATM2",
    bits: 8,
    prompt: "A new persona",
  };
  await f.voice.applySettings("1", changed);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.sessions[0].closed, false);
  assert.deepEqual(await f.controller.settings(), changed);
  assert.deepEqual(f.calls, [
    "join:10",
    "connect",
    "audio",
    "closeAudio",
    "update",
    "connect",
    "audio",
  ]);
  assert.equal(f.voice.isActive("1"), true);
  await f.voice.close();
});
test("settings failure leaves the channel and does not auto-recover", async () => {
  const f = fixture();
  await f.voice.enable("1", { channelId: "10" });
  f.controller.update = async () => {
    throw new Error("Reload failed");
  };
  await assert.rejects(f.voice.applySettings("1", settings));
  assert.equal(f.sessions[0].closed, true);
  assert.equal(f.voice.isActive("1"), false);
  await f.voice.synchronize(new Map([["1", { channelId: "10" }]]));
  assert.equal(f.sessions.length, 1);
  await f.voice.close();
});
test("changing channel creates fresh context, and stop/restart require a new manual activation", async () => {
  const f = fixture();
  await f.voice.enable("1", { channelId: "10" });
  await f.voice.synchronize(new Map([["1", { channelId: "11" }]]));
  assert.equal(f.sessions[0].closed, true);
  assert.equal(f.sessions[1].channelId, "11");
  await f.voice.action("1", "restart");
  assert.equal(f.voice.isActive("1"), false);
  await f.voice.synchronize(new Map([["1", { channelId: "11" }]]));
  assert.equal(f.sessions.length, 2);
  await f.voice.close();
});
test("other webapp and guild conversations cannot be interrupted by voice service controls", async () => {
  const f = fixture();
  f.engine.conversationActive = true;
  await assert.rejects(
    f.voice.applySettings("1", settings),
    /Another conversation/,
  );
  await assert.rejects(f.voice.action("1", "stop"), /Another conversation/);
  f.engine.conversationActive = false;
  await f.voice.enable("1", { channelId: "10" });
  await assert.rejects(f.voice.enable("2", { channelId: "10" }), /already/);
  await assert.rejects(f.voice.action("2", "stop"), /Another server/);
  await f.voice.close();
});
test("voice remains optional and validates settings and controller URL without reading credentials", async () => {
  assert.equal(await VoiceController.fromEnvironment({}), undefined);
  await assert.rejects(
    VoiceController.fromEnvironment({
      NOX_VOICE_CONTROLLER_URL: "http://localhost",
    }),
    /invalid/,
  );
  for (const value of [
    { ...settings, bits: 7 },
    { ...settings, voice: "fake" },
    { ...settings, prompt: "a".repeat(4097) },
    { ...settings, url: "https://other" },
  ])
    assert.throws(() => validateVoiceSettings(value));
  const f = fixture();
  const voice = new VoiceService(undefined, f.discord);
  assert.equal((await voice.status("1")).configured, false);
  await assert.rejects(
    voice.enable("1", { channelId: "10" }),
    /not configured/,
  );
  await voice.close();
});
test("persisted enabled configuration is dormant on process startup; existing text plugin still works", async (t) => {
  const f = await memoryState(t),
    v = fixture();
  f.plugins.attachVoice(v.voice);
  await f.state.put(
    "plugin",
    "1",
    "voice",
    {
      guildId: "1",
      pluginId: "voice",
      enabled: true,
      settings: { channelId: "10" },
      secrets: {},
    },
    "0",
  );
  assert.equal(f.plugins.configuration("voice", "1").enabled, false);
  assert.equal(v.sessions.length, 0);
  const revision = () => f.plugins.configuration("voice", "1").revision;
  await f.plugins.setEnabled("voice", "1", true, revision());
  assert.equal(f.plugins.configuration("voice", "1").enabled, true);
  await f.plugins.setEnabled("ping", "1", true, "0");
  assert.deepEqual(
    new CommandRegistry(f.plugins).desired("1").map((c) => c.name),
    ["nox", "ping"],
  );
  v.sessions[0].fail();
  f.disconnect();
  await f.plugins.synchronize();
  assert.equal(f.plugins.configuration("voice", "1").enabled, false);
  assert.equal(f.plugins.isActive("ping", "1"), true);
  await f.recover();
  assert.equal(v.sessions.length, 1);
  await f.plugins.setEnabled("voice", "1", true, revision());
  assert.equal(v.sessions.length, 2);
  await f.plugins.setEnabled("voice", "1", false, revision());
  assert.equal(v.engine.state, "ready");
});
test("stale enable cannot join and stale saves leave an existing conversation unchanged", async (t) => {
  const f = await memoryState(t),
    v = fixture();
  f.plugins.attachVoice(v.voice);
  await f.plugins.configure("voice", "1", {
    settings: { channelId: "10" },
    expectedRevision: "0",
  });
  await assert.rejects(
    f.plugins.setEnabled("voice", "1", true, "0"),
    /Configuration changed/,
  );
  assert.equal(v.sessions.length, 0);
  const revision = f.plugins.configuration("voice", "1").revision;
  await f.plugins.setEnabled("voice", "1", true, revision);
  await assert.rejects(
    f.plugins.configure("voice", "1", {
      settings: { channelId: "11" },
      expectedRevision: revision,
    }),
  );
  assert.equal(v.sessions.length, 1);
  assert.equal(v.voice.isActive("1"), true);
});

test("concurrent stale enable requests do not disconnect the winning voice session", async (t) => {
  const f = await memoryState(t),
    v = fixture();
  f.plugins.attachVoice(v.voice);
  await f.plugins.configure("voice", "1", {
    settings: { channelId: "10" },
    expectedRevision: "0",
  });
  const revision = f.plugins.configuration("voice", "1").revision;
  const result = await Promise.allSettled([
    f.plugins.setEnabled("voice", "1", true, revision),
    f.plugins.setEnabled("voice", "1", true, revision),
  ]);
  assert.equal(result[0].status, "fulfilled");
  assert.equal(result[1].status, "rejected");
  assert.equal(v.sessions.length, 1);
  assert.equal(v.voice.isActive("1"), true);
});
