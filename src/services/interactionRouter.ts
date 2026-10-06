import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  type Client,
  type Interaction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type User,
  type InteractionReplyOptions,
} from "discord.js";
import { randomBytes } from "node:crypto";
import type { CommandRegistry } from "../core/commandRegistry.js";
import type { QuickCommandService } from "../core/quickCommands.js";
import type { PluginManager } from "../plugins/manager.js";
import type {
  PluginContext,
  RichContent,
  UserSnapshot,
} from "../plugins/sdk.js";
import Logger from "../utils/logger.js";
import type { MessagingService } from "../core/messaging.js";

type Context = Omit<PluginContext, "settings" | "secrets">;
type SavedInteraction = {
  userId: string;
  guildId: string;
  pluginId?: string;
  handler?: string;
  context?: Context;
  page?: number;
  quick?: string;
  expires: number;
};
export class InteractionRouter {
  private sessions = new Map<string, SavedInteraction>();
  constructor(
    private readonly client: Client,
    private readonly registry: CommandRegistry,
    private readonly plugins: PluginManager,
    private readonly quick: QuickCommandService,
    private readonly messaging: MessagingService,
  ) {}
  private key(session: Omit<SavedInteraction, "expires">): string {
    for (const [id, saved] of this.sessions)
      if (saved.expires < Date.now()) this.sessions.delete(id);
    if (this.sessions.size > 10000)
      throw new Error("Too many active interactions. Please try again later.");
    const id = `nox:${randomBytes(16).toString("hex")}`;
    this.sessions.set(id, { ...session, expires: Date.now() + 14 * 60 * 1000 });
    return id;
  }
  private snapshot(user: User, member?: GuildMember): UserSnapshot {
    return {
      id: user.id,
      username: user.username,
      avatarURL: user.displayAvatarURL({ size: 256 }),
      createdTimestamp: user.createdTimestamp,
      joinedTimestamp: member?.joinedTimestamp ?? null,
      roles: member
        ? [...member.roles.cache.values()]
            .filter((role) => role.id !== member.guild.id)
            .map((role) => role.toString())
        : [],
    };
  }
  private async context(
    interaction: ChatInputCommandInteraction,
    includeMembers: boolean,
  ): Promise<Context> {
    const options: Context["options"] = {},
      users: Context["users"] = {};
    let member = interaction.guild?.members.cache.get(interaction.user.id);
    if (includeMembers && !member && interaction.guild) {
      try {
        member = await interaction.guild.members.fetch(interaction.user.id);
      } catch {
        /* The private identity response can still show account data. */
      }
    }
    const context: Context = {
      guildId: interaction.guildId!,
      command: interaction.commandName,
      user: this.snapshot(interaction.user, member),
      options,
      users,
      latencyMs: Math.max(0, Date.now() - interaction.createdTimestamp),
    };
    const flatten = async (
      entries: typeof interaction.options.data,
    ): Promise<void> => {
      for (const option of entries) {
        if (option.options) await flatten(option.options);
        if (
          typeof option.value === "string" ||
          typeof option.value === "number" ||
          typeof option.value === "boolean"
        )
          options[option.name] = option.value;
        if (includeMembers && option.user) {
          let targetMember = interaction.guild?.members.cache.get(
            option.user.id,
          );
          if (!targetMember && interaction.guild) {
            try {
              targetMember = await interaction.guild.members.fetch(
                option.user.id,
              );
            } catch {
              /* Identity remains valid when membership is unavailable. */
            }
          }
          users[option.user.id] = this.snapshot(option.user, targetMember);
        }
      }
    };
    await flatten(interaction.options.data);
    return context;
  }
  private rich(
    result: RichContent,
    pluginId: string,
    context: Context,
  ): InteractionReplyOptions {
    const components: Array<
      | ActionRowBuilder<ButtonBuilder>
      | ActionRowBuilder<StringSelectMenuBuilder>
    > = [];
    let buttons: ButtonBuilder[] = [];
    const flush = () => {
      if (buttons.length)
        components.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(buttons),
        );
      buttons = [];
    };
    for (const component of result.components ?? []) {
      const id = this.key({
        userId: context.user.id,
        guildId: context.guildId,
        pluginId,
        handler: component.action,
        context,
      });
      if (component.kind === "button") {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(id)
            .setLabel(component.label)
            .setStyle(
              component.style === "primary"
                ? ButtonStyle.Primary
                : component.style === "danger"
                  ? ButtonStyle.Danger
                  : ButtonStyle.Secondary,
            )
            .setDisabled(component.disabled ?? false),
        );
        if (buttons.length === 5) flush();
      } else {
        flush();
        components.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(id)
              .setPlaceholder(component.placeholder ?? "Choose an option")
              .addOptions(component.options),
          ),
        );
      }
    }
    flush();
    return {
      content: result.content,
      embeds: result.embeds,
      components,
      files: result.attachments?.map((file) => ({
        name: file.name,
        attachment: Buffer.from(file.data),
      })),
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    };
  }
  private quickPage(
    guildId: string,
    userId: string,
    page: number,
  ): InteractionReplyOptions {
    const commands = this.quick.list(guildId, true),
      total = Math.max(1, Math.ceil(commands.length / 20));
    const current = Math.max(0, Math.min(page, total - 1)),
      visible = commands.slice(current * 20, current * 20 + 20);
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let offset = 0; offset < visible.length; offset += 5)
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          visible.slice(offset, offset + 5).map(({ data }) =>
            new ButtonBuilder()
              .setCustomId(this.key({ guildId, userId, quick: data.trigger }))
              .setLabel(data.trigger)
              .setStyle(ButtonStyle.Secondary),
          ),
        ),
      );
    if (total > 1)
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(this.key({ guildId, userId, page: current - 1 }))
            .setLabel("Previous")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(current === 0),
          new ButtonBuilder()
            .setCustomId(this.key({ guildId, userId, page: current + 1 }))
            .setLabel("Next")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(current === total - 1),
        ),
      );
    return {
      flags: MessageFlags.Ephemeral,
      embeds: [
        {
          color: 0x8b5cf6,
          title: "Quick Commands",
          description: commands.length
            ? `Choose a command to send its response to this channel.\n\nPage ${current + 1}/${total} · ${commands.length} commands`
            : "No Quick Commands are enabled in this server.",
          footer: { text: "NoX Bot" },
        },
      ],
      components: rows,
    };
  }
  async handle(interaction: Interaction): Promise<void> {
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isButton() &&
      !interaction.isStringSelectMenu() &&
      !interaction.isAutocomplete()
    )
      return;
    try {
      if (
        !interaction.guildId ||
        !this.client.guilds.cache.has(interaction.guildId)
      ) {
        if (interaction.isAutocomplete()) await interaction.respond([]);
        else
          await interaction.reply({
            content:
              "This command is only available in a server where NoX Bot is installed.",
            flags: MessageFlags.Ephemeral,
          });
        return;
      }
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        const saved = this.sessions.get(interaction.customId);
        if (
          !saved ||
          saved.expires <= Date.now() ||
          saved.userId !== interaction.user.id ||
          saved.guildId !== interaction.guildId
        ) {
          await interaction.reply({
            content: "This interaction has expired or belongs to another user.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (saved.page !== undefined) {
          const payload = this.quickPage(
            saved.guildId,
            saved.userId,
            saved.page,
          );
          await interaction.update({
            embeds: payload.embeds,
            components: payload.components,
          });
          return;
        }
        if (saved.quick) {
          const response = this.quick.response(saved.guildId, saved.quick);
          if (!response) {
            await interaction.reply({
              content: "That Quick Command is no longer enabled.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          if (!interaction.channelId)
            throw new Error("This channel cannot receive messages.");
          await this.messaging.send(
            {
              provider: "discord",
              kind: "guild-channel",
              guildId: saved.guildId,
              channelId: interaction.channelId,
            },
            { content: response },
          );
          await interaction.editReply({
            content: `Sent !${saved.quick} to this channel.`,
          });
          return;
        }
        if (saved.pluginId && saved.handler && saved.context) {
          if (!this.plugins.isActive(saved.pluginId, saved.guildId)) {
            await interaction.reply({
              content: "That plugin is no longer enabled in this server.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          await interaction.deferUpdate();
          const context = {
            ...saved.context,
            action: saved.handler,
            values: interaction.isStringSelectMenu()
              ? interaction.values
              : undefined,
          };
          const result = await this.plugins.execute(
            saved.pluginId,
            saved.handler,
            context,
            "component",
          );
          if (!result || Array.isArray(result))
            throw new Error("Invalid plugin response.");
          const payload = this.rich(result, saved.pluginId, context);
          await interaction.editReply({
            content: payload.content ?? null,
            embeds: payload.embeds,
            components: payload.components,
            files: payload.files,
          });
          return;
        }
      }
      if (interaction.isAutocomplete()) {
        const resolved = this.registry.resolve(
          interaction.guildId,
          interaction.commandName,
        );
        if (!resolved) {
          await interaction.respond([]);
          return;
        }
        const focused = interaction.options.getFocused(true);
        const context: Context = {
          guildId: interaction.guildId,
          command: interaction.commandName,
          options: { [focused.name]: focused.value },
          users: {},
          user: this.snapshot(interaction.user),
          latencyMs: 0,
        };
        const result = await this.plugins.execute(
          resolved.plugin.id,
          resolved.command.handler,
          context,
          "autocomplete",
        );
        await interaction.respond(
          Array.isArray(result) ? result.slice(0, 25) : [],
        );
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === "nox") {
        switch (interaction.options.getSubcommand()) {
          case "guildid":
            await interaction.reply({
              content: `Server ID: \`${interaction.guildId}\``,
              flags: MessageFlags.Ephemeral,
            });
            return;
          case "commands":
            await interaction.reply(
              this.quickPage(interaction.guildId, interaction.user.id, 0),
            );
            return;
          case "help": {
            const fields = this.registry
              .help(interaction.guildId)
              .map((plugin) => ({
                name: plugin.name,
                value: plugin.commands
                  .map(
                    (command) =>
                      `\`${command.usage}\` — ${command.description}`,
                  )
                  .join("\n"),
              }));
            await interaction.reply({
              flags: MessageFlags.Ephemeral,
              embeds: [
                {
                  color: 0x8b5cf6,
                  title: "NoX Bot · Help",
                  description:
                    "Commands available in this server.\n\n`/nox commands` — Quick Commands\n`/nox guildid` — Server ID",
                  fields: fields.slice(0, 25),
                },
              ],
            });
            return;
          }
        }
      }
      const resolved = this.registry.resolve(
        interaction.guildId,
        interaction.commandName,
      );
      if (!resolved) {
        await interaction.reply({
          content: "This plugin is not enabled in this server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const context = await this.context(
        interaction,
        resolved.plugin.capabilities.includes("discord-users"),
      );
      const result = await this.plugins.execute(
        resolved.plugin.id,
        resolved.command.handler,
        context,
      );
      if (!result || Array.isArray(result))
        throw new Error("Invalid plugin response.");
      const payload = this.rich(result, resolved.plugin.id, context);
      await interaction.editReply({
        content: payload.content,
        embeds: payload.embeds,
        components: payload.components,
        files: payload.files,
      });
    } catch {
      Logger.error("Discord interaction failed.");
      try {
        if (interaction.isAutocomplete()) {
          await interaction.respond([]);
          return;
        }
        const payload: InteractionReplyOptions = {
          content: "This operation could not be completed. Please try again.",
          flags: MessageFlags.Ephemeral,
        };
        if (interaction.deferred || interaction.replied)
          await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {
        Logger.warn("Interaction error response could not be delivered.");
      }
    }
  }
  close(): void {
    this.sessions.clear();
  }
}
