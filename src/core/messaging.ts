import type { RichContent } from "../plugins/sdk.js";
export type MessageTarget =
  | {
      provider: "discord";
      kind: "guild-channel";
      guildId: string;
      channelId: string;
    }
  | { provider: "discord"; kind: "dm"; userId: string };
export interface MessageReceipt {
  provider: "discord";
  messageId: string;
  channelId: string;
  guildId?: string;
}
export interface MessagingAdapter {
  provider: "discord";
  send(target: MessageTarget, content: RichContent): Promise<MessageReceipt>;
}
export class MessagingService {
  private adapters = new Map<string, MessagingAdapter>();
  constructor(adapters: readonly MessagingAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.provider))
        throw new Error("Duplicate messaging provider.");
      this.adapters.set(adapter.provider, adapter);
    }
  }
  async send(
    target: MessageTarget,
    content: RichContent,
  ): Promise<MessageReceipt> {
    const adapter = this.adapters.get(target.provider);
    if (!adapter) throw new Error("Messaging provider is not available.");
    if (
      !content.content?.trim() &&
      !content.embeds?.length &&
      !content.attachments?.length
    )
      throw new Error("Message content is required.");
    return adapter.send(target, content);
  }
}
