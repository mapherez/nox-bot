import { SlashCommandBuilder, GatewayIntentBits } from "discord.js";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import Logger from "./logger.js";
import configLoader from "./configLoader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function isLoadableModuleFile(file: string): boolean {
  return (file.endsWith(".ts") || file.endsWith(".js")) && !file.endsWith(".d.ts");
}

async function createSlashCommands() {
  try {
    const commandsPath = path.join(__dirname, "..", "commands");
    const commandFiles = fs
      .readdirSync(commandsPath)
      .filter(isLoadableModuleFile);

    const commands = [];

    for (const file of commandFiles) {
      try {
        const filePath = path.join(commandsPath, file);
        const fileUrl = pathToFileURL(filePath).href;
        Logger.info(`[COMMAND_LOADER] Loading command from: ${fileUrl}`);
        const command = await import(fileUrl);

        // Support both default exports and named exports
        let commandModule = command;
        if (command.default) {
          commandModule = command.default;
        }

        // Handle async command factories (functions that return command objects)
        let resolvedCommand = commandModule;
        if (typeof commandModule === 'function') {
          resolvedCommand = await commandModule();
        }

        // Support both old format (name/description) and new format (data)
        let slashCommand;
        if (resolvedCommand.data) {
          // New format with SlashCommandBuilder
          slashCommand = resolvedCommand.data;
          Logger.debug(
            `Loaded slash command with options: ${resolvedCommand.data.name}`
          );
        } else if (resolvedCommand.name && resolvedCommand.description) {
          // Old format
          slashCommand = new SlashCommandBuilder()
            .setName(resolvedCommand.name)
            .setDescription(resolvedCommand.description);
          Logger.debug(`Created slash command: ${resolvedCommand.name}`);
        } else {
          Logger.warn(
            `Command file ${file} is missing required properties (data, name, or description)`
          );
          continue;
        }

        commands.push(slashCommand);
      } catch (error) {
        Logger.error(`Failed to load command file ${file}:`, error);
      }
    }

    Logger.success(`Loaded ${commands.length} slash commands from command files`);
    return commands;
  } catch (error) {
    Logger.error("Failed to create slash commands:", error);
    throw error;
  }
}

async function getClientIntents() {
  try {
    const clientConfig = await configLoader.loadConfig("client");

    const intents = clientConfig.intents
      .map((intentName: string) => {
        const intent = GatewayIntentBits[intentName as keyof typeof GatewayIntentBits];
        if (intent) {
          return intent;
        } else {
          Logger.warn(`Unknown intent: ${intentName}`);
          return null;
        }
      })
      .filter((intent: GatewayIntentBits | null): intent is GatewayIntentBits => intent !== null);

    Logger.success(`Loaded ${intents.length} client intents`);
    return intents;
  } catch (error) {
    Logger.error("Failed to load client intents:", error);
    throw error;
  }
}

export {
  createSlashCommands,
  getClientIntents,
};
