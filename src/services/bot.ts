import { Client, GatewayIntentBits, type ClientEvents } from "discord.js";
import Logger from "../utils/logger.js";
import {
  loadPrefixCommands as loadPrefixCommandsFromFile,
  getPrefixCommandResponse,
} from "../utils/prefixCommands.js";
import { buildPrefixCommandsPage } from "../utils/prefixCommandMenu.js";

class Bot {
  client: Client;
  commandHandler: any;
  prefixCommands: Record<string, string>;
  private readonly eventHandlers: Array<{ event: string; listener: (...args: any[]) => void }> = [];
  private destruction?: Promise<void>;

  constructor(intents: GatewayIntentBits[]) {
    this.client = new Client({ intents });
    this.commandHandler = null;
    this.prefixCommands = this.loadPrefixCommands();
    this.setupEventHandlers();
  }

  loadPrefixCommands(): Record<string, string> {
    return loadPrefixCommandsFromFile();
  }

  setCommandHandler(commandHandler: any): void {
    this.commandHandler = commandHandler;
  }

  setupEventHandlers() {
    const once = <K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void) => {
      this.eventHandlers.push({ event, listener });
      this.client.once(event, listener);
    };
    const on = <K extends keyof ClientEvents>(event: K, listener: (...args: ClientEvents[K]) => void) => {
      this.eventHandlers.push({ event, listener });
      this.client.on(event, listener);
    };
    once("clientReady", () => {
      Logger.success(`Bot online as ${this.client.user?.tag}`);
    });

    on("interactionCreate", async (interaction) => {
      if (interaction.isButton()) {
        const customId = interaction.customId;

        if (customId.startsWith("prefix:page:")) {
          const page = Number(customId.replace("prefix:page:", ""));

          if (Number.isNaN(page)) {
            await interaction.reply({
              content: "Invalid command page.",
              ephemeral: true,
            });
            return;
          }

          await interaction.update(buildPrefixCommandsPage(page));
          return;
        }

        if (customId.startsWith("prefix:cmd:")) {
          const command = customId.replace("prefix:cmd:", "");
          const response = getPrefixCommandResponse(command);

          if (!response) {
            await interaction.reply({
              content: `Command "!${command}" no longer exists.`,
              ephemeral: true,
            });
            return;
          }

          await interaction.reply(response);
          return;
        }
      }

      if (this.commandHandler) {
        await this.commandHandler.handleInteraction(interaction);
      }
    });

    on("messageCreate", async (message) => {
      if (message.author.bot) return; // Ignore bot messages

      if (message.content.startsWith("!")) {
        const command = message.content.slice(1).split(" ")[0].toLowerCase();

        if (command === "help") {
          const commands = Object.keys(this.prefixCommands)
            .sort()
            .map((name) => `!${name}`);

          const response =
            commands.length > 0
              ? `Available commands:\n${commands.join(", ")}`
              : "No prefix commands available.";

          try {
            await message.delete();
          } catch (error) {
            Logger.warn(
              "Could not delete command message:",
              (error as Error).message,
            );
          }

          try {
            await message.channel.send(response);
          } catch (error) {
            Logger.error(
              "Could not send help message:",
              (error as Error).message,
            );
          }

          return;
        }

        const response = this.prefixCommands[command];
        if (response) {
          // Delete the original command message first to prevent spam
          try {
            await message.delete();
          } catch (error) {
            Logger.warn(
              "Could not delete command message:",
              (error as Error).message,
            );
          }

          // Send response as regular message (not reply) since original is deleted
          try {
            await message.channel.send(response);
          } catch (error) {
            Logger.error("Could not send response:", (error as Error).message);
          }
        }
      }
    });

    on("error", (error) => {
      Logger.error("Client error:", error);
    });

    on("warn", (warning) => {
      Logger.warn("Client warning:", warning);
    });
  }

  async login(token: string): Promise<boolean> {
    try {
      await this.client.login(token);
      return true;
    } catch (error) {
      Logger.error("Failed to login:", error);
      throw error;
    }
  }

  destroy(): Promise<void> {
    if (!this.destruction) this.destruction = this.destroyClient();
    return this.destruction;
  }

  private async destroyClient(): Promise<void> {
    Logger.info("Shutting down bot...");
    try { await this.client.destroy(); }
    finally {
      for (const { event, listener } of this.eventHandlers) this.client.off(event, listener);
      this.eventHandlers.length = 0;
    }
    Logger.success("Bot shut down successfully");
  }
}

export default Bot;
