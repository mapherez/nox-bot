import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  Status,
  type Client,
  type Guild,
  type GuildMember,
  type TextChannel,
  type NewsChannel,
} from "discord.js";
import {
  ControlError,
  validateId,
  validateContent,
  type DiscordOperationsContract,
  type DiscordStatus,
  type ChannelSummary,
  type CreatedMessage,
} from "../controlApi.js";
import type {
  MessagingAdapter,
  MessageTarget,
  MessageReceipt,
} from "../core/messaging.js";
import type { RichContent } from "../plugins/sdk.js";

type OperationsClient = Pick<
  Client,
  "isReady" | "ws" | "user" | "guilds" | "channels"
> &
  Partial<Pick<Client, "users">>;
type SendableChannel = TextChannel | NewsChannel;
const sortById = <T extends { id: string }>(items: T[]): T[] =>
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function translateDiscordError(error: unknown): ControlError {
  if (error instanceof ControlError) return error;
  if (error instanceof DiscordAPIError) {
    switch (error.code) {
      case 10003:
        return new ControlError("CHANNEL_NOT_FOUND", "Channel not found.");
      case 10004:
        return new ControlError("GUILD_NOT_FOUND", "Guild not found.");
      case 50001:
      case 50013:
        return new ControlError(
          "INSUFFICIENT_PERMISSIONS",
          "The bot cannot access or send to this resource.",
        );
      case 50035:
        return new ControlError(
          "INVALID_PAYLOAD",
          "Discord rejected the message payload.",
        );
      case 200000:
        return new ControlError(
          "MESSAGE_REJECTED",
          "Discord blocked the message.",
        );
    }
  }
  if (
    (error instanceof HTTPError || error instanceof DiscordAPIError) &&
    error.status >= 500
  ) {
    return new ControlError(
      "DISCORD_UNAVAILABLE",
      "Discord is temporarily unavailable.",
    );
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_SOCKET",
    ].includes(String(error.code))
  ) {
    return new ControlError(
      "DISCORD_UNAVAILABLE",
      "The Discord request could not be completed.",
    );
  }
  // discord.js queues rate limits internally. Do not synthesize a 429 from an event or a delay.
  return new ControlError("INTERNAL_ERROR", "An unexpected error occurred.");
}

export default class DiscordOperations
  implements DiscordOperationsContract, MessagingAdapter
{
  readonly provider = "discord" as const;
  constructor(private readonly client: OperationsClient) {}

  getStatus(): DiscordStatus {
    const ready = this.client.isReady();
    const ws = this.client.ws;
    const state = ready
      ? "connected"
      : [Status.Reconnecting, Status.Resuming].includes(ws.status)
        ? "reconnecting"
        : [
              Status.Connecting,
              Status.Identifying,
              Status.Nearly,
              Status.WaitingForGuilds,
            ].includes(ws.status)
          ? "connecting"
          : "disconnected";
    return {
      discord: {
        state,
        ready,
        pingMs:
          ready && Number.isFinite(ws.ping) && ws.ping >= 0 ? ws.ping : null,
      },
      bot: this.client.user
        ? { id: this.client.user.id, username: this.client.user.username }
        : null,
      guildCount: this.client.guilds.cache.size,
    };
  }

  private assertReady(): void {
    if (!this.client.isReady())
      throw new ControlError("DISCORD_UNAVAILABLE", "Discord is not ready.");
  }

  private getGuild(id: string): Guild {
    const guild = this.client.guilds.cache.get(id);
    if (!guild) throw new ControlError("GUILD_NOT_FOUND", "Guild not found.");
    if (!guild.available)
      throw new ControlError(
        "DISCORD_UNAVAILABLE",
        "The guild is temporarily unavailable.",
      );
    return guild;
  }

  private canSend(channel: SendableChannel, member: GuildMember): boolean {
    const permissions = channel.permissionsFor(member);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ])
    )
      return false;
    return (
      !member.isCommunicationDisabled() ||
      permissions.has(PermissionFlagsBits.Administrator)
    );
  }

  async listGuilds() {
    this.assertReady();
    return sortById(
      [...this.client.guilds.cache.values()].map(({ id, name }) => ({
        id,
        name,
      })),
    );
  }

  async listChannels(guildId: string): Promise<ChannelSummary[]> {
    validateId(guildId);
    this.assertReady();
    try {
      const guild = this.getGuild(guildId);
      const channels = await guild.channels.fetch();
      const member = guild.members.me ?? (await guild.members.fetchMe());
      this.assertReady();
      this.getGuild(guildId);
      const result: ChannelSummary[] = [];
      for (const channel of channels.values()) {
        if (
          channel &&
          (channel.type === ChannelType.GuildText ||
            channel.type === ChannelType.GuildAnnouncement) &&
          this.canSend(channel, member)
        ) {
          result.push({
            id: channel.id,
            name: channel.name,
            type:
              channel.type === ChannelType.GuildText ? "text" : "announcement",
          });
        }
      }
      return sortById(result);
    } catch (error) {
      throw translateDiscordError(error);
    }
  }

  async send(
    target: MessageTarget,
    content: RichContent,
  ): Promise<MessageReceipt> {
    this.assertReady();
    if (content.components?.length)
      throw new ControlError(
        "INVALID_PAYLOAD",
        "Interactive content must be sent through a private interaction.",
      );
    if (content.content !== undefined) validateContent(content.content);
    const payload = {
      content: content.content,
      embeds: content.embeds,
      files: content.attachments?.map((file) => ({
        name: file.name,
        attachment: Buffer.from(file.data),
      })),
      allowedMentions: { parse: [] as [] },
    };
    try {
      if (target.kind === "dm") {
        validateId(target.userId);
        if (!this.client.users)
          throw new ControlError(
            "DISCORD_UNAVAILABLE",
            "Discord users are unavailable.",
          );
        const user = await this.client.users.fetch(target.userId);
        const message = await user.send(payload);
        return {
          provider: "discord",
          messageId: message.id,
          channelId: message.channelId,
        };
      }
      validateId(target.guildId);
      validateId(target.channelId);
      this.getGuild(target.guildId);
      const { channel, guild } = await this.sendable(
        target.channelId,
        target.guildId,
      );
      const message = await channel.send(payload);
      return {
        provider: "discord",
        messageId: message.id,
        channelId: message.channelId,
        guildId: guild.id,
      };
    } catch (error) {
      throw translateDiscordError(error);
    }
  }
  async sendMessage(
    channelId: string,
    content: string,
  ): Promise<CreatedMessage> {
    validateId(channelId);
    validateContent(content);
    this.assertReady();
    try {
      const { channel, guild } = await this.sendable(channelId);
      const message = await channel.send({ content });
      return {
        messageId: message.id,
        channelId: message.channelId,
        guildId: guild.id,
      };
    } catch (error) {
      throw translateDiscordError(error);
    }
  }
  private async sendable(
    channelId: string,
    expectedGuildId?: string,
  ): Promise<{ channel: SendableChannel; guild: Guild }> {
    const channel = await this.client.channels.fetch(channelId, {
      force: true,
    });
    if (!channel)
      throw new ControlError("CHANNEL_NOT_FOUND", "Channel not found.");
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      throw new ControlError(
        "INVALID_CHANNEL",
        "Only guild text and announcement channels are supported.",
      );
    }
    if (expectedGuildId && channel.guildId !== expectedGuildId)
      throw new ControlError(
        "INVALID_CHANNEL",
        "The channel does not belong to this server.",
      );
    const guild = this.getGuild(channel.guildId);
    const member = guild.members.me ?? (await guild.members.fetchMe());
    this.assertReady();
    this.getGuild(guild.id);
    if (!this.canSend(channel, member))
      throw new ControlError(
        "INSUFFICIENT_PERMISSIONS",
        "The bot cannot send messages to this channel.",
      );
    return { channel, guild };
  }
}
