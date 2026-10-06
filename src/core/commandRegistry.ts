import type { RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";
import type { PluginManager } from "../plugins/manager.js";

const coreCommand: RESTPostAPIChatInputApplicationCommandsJSONBody = {
  name: "nox",
  description: "NoX Bot help and Quick Commands",
  options: [
    {
      type: 1,
      name: "help",
      description: "Show commands available in this server",
    },
    {
      type: 1,
      name: "commands",
      description: "Browse this server’s Quick Commands",
    },
    { type: 1, name: "guildid", description: "Show the current server ID" },
  ],
};
export class CommandRegistry {
  constructor(private readonly plugins: PluginManager) {}
  desired(guildId: string): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    return [
      structuredClone(coreCommand),
      ...this.plugins
        .definitions()
        .filter((plugin) => this.plugins.commandsAvailable(plugin.id, guildId))
        .flatMap((plugin) =>
          plugin.commands.map((command) => ({
            name: command.name,
            description: command.description,
            options: command.options
              ? structuredClone(command.options)
              : undefined,
          })),
        ),
    ];
  }
  resolve(guildId: string, name: string) {
    for (const plugin of this.plugins.definitions()) {
      if (!this.plugins.commandsAvailable(plugin.id, guildId)) continue;
      const command = plugin.commands.find((command) => command.name === name);
      if (command) return { plugin, command };
    }
  }
  help(guildId: string) {
    return this.plugins
      .definitions()
      .filter((plugin) => this.plugins.commandsAvailable(plugin.id, guildId))
      .map((plugin) => ({
        name: plugin.name,
        commands: plugin.commands.map((command) => ({
          usage: command.usage,
          description: command.description,
        })),
      }));
  }
}
