import { EventEmitter } from "node:events";
import type { Settings } from "../core/state.js";
import type {
  EngineStatus,
  VoiceSettings,
  VoiceStatus,
} from "../shared/voice.js";
import { quantizationBits, voiceNames } from "../shared/voice.js";
import type { Controller } from "./controller.js";
import type { Conversation, VoiceDiscord } from "./discord.js";
import { VoiceError } from "./errors.js";

export function validateVoiceSettings(value: unknown): VoiceSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new VoiceError("Invalid voice settings.", 400);
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some(
      (key) => !["voice", "prompt", "bits"].includes(key),
    ) ||
    !voiceNames.includes(data.voice as (typeof voiceNames)[number]) ||
    typeof data.prompt !== "string" ||
    data.prompt.length > 4096 ||
    !quantizationBits.includes(data.bits as (typeof quantizationBits)[number])
  )
    throw new VoiceError(
      "Choose a supported voice, prompt (up to 4096 characters) and quantization.",
      400,
    );
  return {
    voice: data.voice as string,
    prompt: data.prompt,
    bits: data.bits as number,
  };
}
export class VoiceService extends EventEmitter {
  private session?: {
    guildId: string;
    channelId: string;
    conversation?: Conversation;
  };
  private serial: Promise<unknown> = Promise.resolve();
  private closing = false;
  private state: VoiceStatus["state"] = "inactive";
  private error?: string;
  constructor(
    private readonly controller: Controller | undefined,
    private readonly discord: VoiceDiscord,
    initialError?: string,
  ) {
    super();
    this.error = initialError;
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation);
    this.serial = next.catch(() => {});
    return next;
  }
  isActive(guildId: string) {
    return this.session?.guildId === guildId && this.state === "active";
  }
  runtimeStatus() {
    return {
      state: this.state,
      error: this.error,
      guildCount: this.session ? 1 : 0,
    };
  }
  private client() {
    if (!this.controller)
      throw new VoiceError(
        this.error ??
          "NoX Voice is not configured. Set the controller URL and mount the three client certificate files.",
        503,
      );
    return this.controller;
  }
  channels(guildId: string) {
    return this.discord.channels(guildId);
  }
  async validateChannel(guildId: string, settings: Settings) {
    const channelId = settings.channelId;
    if (typeof channelId !== "string" || !/^\d{1,20}$/.test(channelId))
      throw new VoiceError(
        "Select and save a voice channel before enabling NoX Voice.",
        400,
      );
    await this.discord.validate(guildId, channelId);
    return channelId;
  }
  async status(guildId: string): Promise<VoiceStatus> {
    const base = {
      configured: !!this.controller,
      active: this.isActive(guildId),
      state: this.state,
      error: this.error,
      channelId:
        this.session?.guildId === guildId ? this.session.channelId : undefined,
      ownsConversation: this.session?.guildId === guildId,
    };
    try {
      const controller = this.client();
      const [engine, settings] = await Promise.all([
        controller.status(),
        controller.settings(),
      ]);
      return { ...base, controller: "ready", engine, settings };
    } catch (error) {
      return {
        ...base,
        controller: "unavailable",
        error:
          error instanceof VoiceError
            ? error.message
            : "nox-voice-mlx controller unavailable.",
      };
    }
  }
  enable(guildId: string, settings: Settings): Promise<void> {
    return this.run(() => this.enter(guildId, settings));
  }
  private async enter(guildId: string, settings: Settings): Promise<void> {
    if (this.closing) throw new VoiceError("The bot is shutting down.", 503);
    if (this.session) {
      if (
        this.isActive(guildId) &&
        this.session.channelId === settings.channelId
      )
        return;
      throw new VoiceError(
        "NoX Voice already has a conversation. Disable it before joining another channel.",
      );
    }
    const channelId = await this.validateChannel(guildId, settings),
      controller = this.client();
    await this.assertReady(controller);
    if (this.closing) throw new VoiceError("The bot is shutting down.", 503);
    this.state = "starting";
    this.error = undefined;
    const session = {
      guildId,
      channelId,
      conversation: undefined as Conversation | undefined,
    };
    this.session = session;
    this.emit("change");
    try {
      session.conversation = await this.discord.join(guildId, channelId, () =>
        this.failed(session),
      );
      if (this.session !== session) {
        session.conversation.close();
        throw new VoiceError("Discord voice disconnected.", 503);
      }
      await this.open(session, controller);
      if (this.session !== session)
        throw new VoiceError("Voice session disconnected.", 503);
      this.state = "active";
      this.emit("change");
    } catch (error) {
      this.failed(session);
      throw error;
    }
  }
  private async assertReady(controller: Controller) {
    const status = await controller.status();
    if (status.state !== "ready" || status.settingsChanging)
      throw new VoiceError(
        "Start the engine in nox-voice-mlx and wait until it is ready before enabling NoX Voice.",
      );
    if (status.conversationActive)
      throw new VoiceError(
        "The voice service is in use by another conversation. End it before enabling NoX Voice.",
      );
  }
  private async open(
    session: NonNullable<VoiceService["session"]>,
    controller: Controller,
  ) {
    const socket = await controller.connect();
    if (this.session !== session) {
      socket.terminate();
      throw new VoiceError("Voice session cancelled.");
    }
    await session.conversation!.open(socket);
  }
  private failed(session: NonNullable<VoiceService["session"]>) {
    if (this.session !== session) return;
    session.conversation?.close();
    this.session = undefined;
    this.state = "error";
    this.error =
      "Voice disconnected. Check Discord and nox-voice-mlx, then explicitly enable the plugin again.";
    this.emit("change");
  }
  private leave() {
    const session = this.session;
    this.session = undefined;
    session?.conversation?.close();
    this.state = "inactive";
    this.error = undefined;
    this.emit("change");
  }
  disable(guildId: string) {
    return this.run(async () => {
      if (!this.session || this.session.guildId === guildId) this.leave();
    });
  }
  synchronize(configurations: ReadonlyMap<string, Settings>) {
    return this.run(async () => {
      const session = this.session;
      if (!session) return; // Persisted enabled flags NEVER auto-join after startup or failure.
      const settings = configurations.get(session.guildId);
      if (!settings) {
        this.leave();
        return;
      }
      if (settings.channelId === session.channelId) return;
      try {
        const channelId = await this.validateChannel(session.guildId, settings);
        this.leave();
        await this.waitForRelease(this.client());
        await this.enter(session.guildId, { channelId });
      } catch {
        this.session?.conversation?.close();
        this.session = undefined;
        this.state = "error";
        this.error =
          "Could not move voice channel. Explicitly enable the plugin again.";
        this.emit("change");
      }
    });
  }
  private async waitForRelease(controller: Controller) {
    const deadline = performance.now() + 5000;
    while ((await controller.status()).conversationActive) {
      if (performance.now() >= deadline)
        throw new VoiceError(
          "The previous conversation has not closed yet. Try again shortly.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  applySettings(guildId: string, value: unknown) {
    const settings = validateVoiceSettings(value);
    return this.run(async () => {
      const controller = this.client(),
        session = this.session;
      if (session && session.guildId !== guildId)
        throw new VoiceError("Another server is using NoX Voice.");
      try {
        if (session) {
          this.state = "starting";
          this.emit("change");
          session.conversation!.closeAudio();
          await this.waitForRelease(controller);
        } else if ((await controller.status()).conversationActive)
          throw new VoiceError(
            "Another conversation is using the voice service. End it before changing settings.",
          );
        const result = await controller.update(settings);
        if (session) {
          if (this.session !== session)
            throw new VoiceError(
              "Discord disconnected while applying settings.",
            );
          await this.open(session, controller);
          this.state = "active";
          this.emit("change");
        }
        return result;
      } catch (error) {
        if (session) this.failed(session);
        throw error;
      }
    });
  }
  action(
    guildId: string,
    action: "start" | "stop" | "restart",
  ): Promise<EngineStatus> {
    return this.run(async () => {
      const controller = this.client();
      if (this.session && this.session.guildId !== guildId)
        throw new VoiceError("Another server is using NoX Voice.");
      if (action !== "start") {
        if (this.session) {
          this.leave();
          await this.waitForRelease(controller);
        }
        if ((await controller.status()).conversationActive)
          throw new VoiceError(
            "Another conversation is using the voice service. End it before stopping or restarting the engine.",
          );
      }
      return controller.action(action);
    });
  }
  async diagnostics(guildId: string) {
    const status = await this.status(guildId);
    return { status, diagnostics: await this.client().diagnostics() };
  }
  async close() {
    this.closing = true;
    this.leave();
    await this.serial;
    this.leave();
  }
  abort() {
    if (this.session) this.failed(this.session);
  }
  forceClose() {
    this.closing = true;
    this.leave();
  }
}
