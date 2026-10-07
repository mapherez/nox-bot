import {
  ControlError,
  validateId,
  type DiscordOperationsContract,
} from "../controlApi.js";
import type { StateStore } from "../core/state.js";
import type { QuickCommandService } from "../core/quickCommands.js";
import type { PluginManager } from "../plugins/manager.js";
import type { GuildSnapshot } from "../shared/dashboard.js";

// Shared confirmed projection used by the dashboard and the guild MCP adapter.
export class GuildConfigurationService {
  constructor(
    private readonly state: StateStore,
    private readonly operations: DiscordOperationsContract,
    private readonly plugins: PluginManager,
    private readonly quick: QuickCommandService,
    private readonly publicOrigin: string,
    private readonly commandStatus: (guildId: string) => {
      state: string;
      error?: string;
    },
  ) {}

  async assertGuild(guildId: string): Promise<void> {
    validateId(guildId);
    if (
      !(await this.operations.listGuilds()).some(
        (guild) => guild.id === guildId,
      )
    )
      throw new ControlError(
        "GUILD_NOT_FOUND",
        "The bot is not installed in this server.",
      );
  }

  snapshot(guildId: string): GuildSnapshot {
    return {
      guildId,
      mcp: { url: new URL(`/mcp/guilds/${guildId}`, this.publicOrigin).href },
      revision: this.state.revision,
      synchronization: this.state.synchronization,
      initialized: this.state.initialized,
      writable: this.state.writable,
      commandSynchronization: this.commandStatus(guildId),
      plugins: this.plugins.definitions().map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        icon: plugin.icon,
        dashboardEntry: plugin.dashboardEntry,
        configurable:
          Object.keys(plugin.defaults).length > 0 ||
          plugin.secretFields.length > 0,
        commands: plugin.commands.map(({ name, usage, description }) => ({
          name,
          usage,
          description,
        })),
        configuration: this.plugins.configuration(plugin.id, guildId),
      })),
      quickCommands: this.quick.list(guildId).map(({ revision, data }) => ({
        revision,
        trigger: data.trigger,
        response: data.response,
        enabled: data.enabled,
      })),
    };
  }
}
