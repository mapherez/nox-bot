import { Client, GatewayIntentBits, type ClientEvents } from "discord.js";
import type { InteractionRouter } from "./interactionRouter.js";
import type { QuickCommandService } from "../core/quickCommands.js";
import type { MessagingService } from "../core/messaging.js";
import Logger from "../utils/logger.js";

export default class Bot {
  readonly client: Client;
  private router?: InteractionRouter;
  private quick?: QuickCommandService;
  private messaging?: MessagingService;
  private handlers: Array<() => void> = [];
  private destruction?: Promise<void>;
  constructor(
    intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  ) {
    this.client = new Client({ intents });
    this.on("clientReady", () =>
      Logger.success(`NoX Bot online as ${this.client.user?.tag}`),
    );
    this.on("error", () => Logger.error("Discord client error."));
    this.on("warn", () => Logger.warn("Discord client warning."));
    this.on("interactionCreate", (interaction) => {
      void this.router?.handle(interaction);
    });
    this.on("messageCreate", (message) => {
      if (
        message.author.bot ||
        !message.guildId ||
        !message.content.startsWith("!") ||
        !this.quick ||
        !this.messaging
      )
        return;
      const trigger = message.content.slice(1).split(/\s/, 1)[0].toLowerCase();
      const response =
        trigger === "help"
          ? this.quick
              .list(message.guildId, true)
              .map((command) => `!${command.data.trigger}`)
              .join(", ") || "No Quick Commands are enabled in this server."
          : this.quick.response(message.guildId, trigger);
      if (!response) return;
      void (async () => {
        try {
          await message.delete();
        } catch {
          Logger.warn("Quick Command input could not be deleted.");
        }
        try {
          for (let offset = 0; offset < response.length; offset += 2000)
            await this.messaging!.send(
              {
                provider: "discord",
                kind: "guild-channel",
                guildId: message.guildId!,
                channelId: message.channelId,
              },
              { content: response.slice(offset, offset + 2000) },
            );
        } catch {
          Logger.error("Quick Command response could not be sent.");
        }
      })();
    });
  }
  attach(
    router: InteractionRouter,
    quick: QuickCommandService,
    messaging: MessagingService,
  ): void {
    this.router = router;
    this.quick = quick;
    this.messaging = messaging;
  }
  on<K extends keyof ClientEvents>(
    event: K,
    handler: (...args: ClientEvents[K]) => void,
  ): void {
    this.client.on(event, handler);
    this.handlers.push(() => this.client.off(event, handler));
  }
  async login(token: string): Promise<void> {
    await this.client.login(token);
  }
  destroy(): Promise<void> {
    return (this.destruction ??= (async () => {
      this.router?.close();
      await this.client.destroy();
      this.handlers.forEach((remove) => remove());
      this.handlers = [];
    })());
  }
}
