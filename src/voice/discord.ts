import opus from "@discordjs/opus";
import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
} from "@discordjs/voice";
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type VoiceBasedChannel,
} from "discord.js";
import WebSocket from "ws";
import { DiscordDownsampler, InputMixer } from "./audio.js";
import { EngineAudio } from "./stream.js";
import { VoiceError } from "./errors.js";
import type { VoiceChannel } from "../shared/voice.js";

const { OpusEncoder } = opus;

export interface Conversation {
  open(socket: WebSocket): Promise<void>;
  closeAudio(): void;
  close(): void;
}
export interface VoiceDiscord {
  channels(guildId: string): Promise<VoiceChannel[]>;
  validate(guildId: string, channelId: string): Promise<void>;
  join(
    guildId: string,
    channelId: string,
    onFailure: () => void,
  ): Promise<Conversation>;
}
export class DiscordVoice implements VoiceDiscord {
  constructor(private readonly client: Client) {}
  private async channel(guildId: string, channelId: string) {
    const guild = await this.client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (
      !channel ||
      channel.type !== ChannelType.GuildVoice ||
      !channel
        .permissionsFor(me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ])
    )
      throw new VoiceError(
        "Choose a normal voice channel where the bot has View Channel, Connect and Speak permissions.",
        400,
      );
    return channel;
  }
  async channels(guildId: string) {
    const guild = await this.client.guilds.fetch(guildId);
    const me = guild.members.me ?? (await guild.members.fetchMe());
    return [...(await guild.channels.fetch()).values()]
      .filter(
        (channel) =>
          channel?.type === ChannelType.GuildVoice &&
          channel
            .permissionsFor(me)
            ?.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
            ]),
      )
      .map((channel) => ({ id: channel!.id, name: channel!.name }));
  }
  async validate(guildId: string, channelId: string) {
    await this.channel(guildId, channelId);
  }
  async join(guildId: string, channelId: string, onFailure: () => void) {
    const channel = await this.channel(guildId, channelId);
    const session = new DiscordConversation(this.client, channel, onFailure);
    try {
      await session.ready();
      return session;
    } catch {
      session.close();
      throw new VoiceError(
        "Could not join Discord voice. Check channel permissions and UDP connectivity.",
        503,
      );
    }
  }
}
class DiscordConversation implements Conversation {
  private connection;
  private player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  private subscriptions = new Map<string, AudioReceiveStream>();
  private mixer = new InputMixer();
  private audio?: EngineAudio;
  private closed = false;
  private onSpeaking = (id: string) => this.subscribe(id);
  constructor(
    private client: Client,
    private channel: VoiceBasedChannel,
    private onFailure: () => void,
  ) {
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    });
    this.connection.on("error", () => this.fail());
    this.player.on("error", () => this.fail());
    this.connection.on("stateChange", (_old, state) => {
      if (
        state.status === VoiceConnectionStatus.Disconnected ||
        state.status === VoiceConnectionStatus.Destroyed
      )
        this.fail();
    });
    this.connection.receiver.speaking.on("start", this.onSpeaking);
    this.connection.subscribe(this.player);
    this.client.on("voiceStateUpdate", this.onVoiceState);
  }
  private onVoiceState = (
    oldState: import("discord.js").VoiceState,
    state: import("discord.js").VoiceState,
  ) => {
    if (state.guild.id !== this.channel.guild.id) return;
    if (
      state.id === this.client.user?.id &&
      (state.channelId !== this.channel.id ||
        state.serverDeaf ||
        state.serverMute)
    )
      this.fail();
    if (
      oldState.channelId === this.channel.id &&
      state.channelId !== this.channel.id
    ) {
      this.subscriptions.get(state.id)?.destroy();
      this.subscriptions.delete(state.id);
      this.mixer.remove(state.id);
    }
  };
  ready() {
    return entersState(this.connection, VoiceConnectionStatus.Ready, 20000);
  }
  private subscribe(id: string) {
    const member = this.channel.members.get(id);
    if (
      this.closed ||
      !this.audio ||
      !member ||
      member.user.bot ||
      this.subscriptions.has(id)
    )
      return;
    const stream = this.connection.receiver.subscribe(id, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 200 },
    });
    const decoder = new OpusEncoder(48000, 2),
      resampler = new DiscordDownsampler();
    this.subscriptions.set(id, stream);
    stream.on("data", (packet: Buffer) => {
      if (!this.audio || this.closed) return;
      try {
        this.mixer.push(id, resampler.convert(decoder.decode(packet)));
      } catch {
        this.fail();
      }
    });
    stream.on("error", () => this.fail());
    stream.once("close", () => {
      if (this.subscriptions.get(id) === stream) this.subscriptions.delete(id);
    });
  }
  open(socket: WebSocket): Promise<void> {
    if (this.closed) {
      socket.terminate();
      return Promise.reject(new VoiceError("Discord voice disconnected.", 503));
    }
    this.closeAudio();
    const audio = new EngineAudio(
      socket,
      () => this.mixer.frame(),
      () => this.fail(),
    );
    this.audio = audio;
    this.player.play(
      createAudioResource(audio.output, { inputType: StreamType.Opus }),
    );
    for (const member of this.channel.members.values()) {
      if (this.connection.receiver.speaking.users.has(member.id))
        this.subscribe(member.id);
    }
    return audio.start();
  }
  closeAudio(): void {
    const audio = this.audio;
    this.audio = undefined;
    audio?.close();
    this.player.stop(true);
    for (const stream of this.subscriptions.values()) stream.destroy();
    this.subscriptions.clear();
    this.mixer = new InputMixer();
  }
  private fail(): void {
    if (this.closed) return;
    this.close();
    this.onFailure();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeAudio();
    this.client.off("voiceStateUpdate", this.onVoiceState);
    this.connection.receiver.speaking.off("start", this.onSpeaking);
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed)
      this.connection.destroy();
  }
}
