import type { IncomingMessage, ServerResponse } from "node:http";
import { McpError, type ExecutionContext, type ToolDefinition } from "@nox/mcp";
import { toNodeHandler } from "@nox/mcp/node";
import { z } from "zod";
import {
  ControlError,
  type DiscordOperationsContract,
  type ProcessState,
  type ServiceInfo,
} from "../controlApi.js";
import { StateError } from "../core/state.js";
import type { MessagingService } from "../core/messaging.js";
import type { CommandRegistry } from "../core/commandRegistry.js";
import type { QuickCommandService } from "../core/quickCommands.js";
import type { PluginManager } from "../plugins/manager.js";
import type { GuildConfigurationService } from "./guildConfiguration.js";
import Logger from "../utils/logger.js";
import { createJsonHttpHandler } from "./mcpHttp.js";

const empty = z.strictObject({});
const pluginInput = z.strictObject({ pluginId: z.string() });
const pluginWriteInput = pluginInput.extend({ expectedRevision: z.string() });
const quickInput = z.strictObject({
  trigger: z.string(),
  response: z.string(),
  enabled: z.boolean(),
});
const quickSchema = z.object({
  revision: z.string(),
  trigger: z.string(),
  response: z.string(),
  enabled: z.boolean(),
});
const commandStatusSchema = z.object({
  state: z.string(),
  error: z.string().optional(),
});
const pluginSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  icon: z.string(),
  dashboardEntry: z.string(),
  configurable: z.boolean(),
  commands: z.array(
    z.object({ name: z.string(), usage: z.string(), description: z.string() }),
  ),
  configuration: z.object({
    revision: z.string(),
    enabled: z.boolean(),
    settings: z.record(z.string(), z.json()),
    secrets: z.record(z.string(), z.object({ configured: z.boolean() })),
    runtime: z.string(),
    error: z.string().optional(),
  }),
});
const snapshotSchema = z.object({
  guildId: z.string(),
  mcp: z.object({ url: z.string() }),
  revision: z.string(),
  synchronization: z.string(),
  initialized: z.boolean(),
  writable: z.boolean(),
  commandSynchronization: commandStatusSchema,
  plugins: z.array(pluginSchema),
  quickCommands: z.array(quickSchema),
});

interface McpDependencies {
  guilds: GuildConfigurationService;
  operations: DiscordOperationsContract;
  messaging: MessagingService;
  plugins: PluginManager;
  quick: QuickCommandService;
  registry: CommandRegistry;
  info: ServiceInfo;
  processState(): ProcessState;
}

export function formatMcpError(error: unknown) {
  if (error instanceof McpError) return error.toJSON();
  if (error instanceof ControlError || error instanceof StateError)
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      ...(error instanceof StateError && error.code === "WRITE_UNCONFIRMED"
        ? { details: { outcome: "unknown" } }
        : {}),
    };
  // Match the dashboard's safe response for legacy service validation errors.
  return {
    code: "INVALID_REQUEST",
    message:
      "The request could not be completed. Check the configuration and try again.",
    retryable: false,
  };
}

export class GuildMcpServer {
  private stopping = false;
  private readonly active = new Set<Promise<unknown>>();
  private readonly handlers = new Set<
    ReturnType<typeof createJsonHttpHandler>
  >();
  private closing?: Promise<void>;

  constructor(private readonly services: McpDependencies) {}

  private assertAvailable(allowStarting = false): void {
    const state = this.services.processState();
    if (
      this.stopping ||
      state === "stopping" ||
      (!allowStarting && state !== "running")
    )
      throw new ControlError(
        "SERVICE_UNAVAILABLE",
        "The process is starting or stopping.",
      );
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.then(
      () => this.active.delete(work),
      () => this.active.delete(work),
    );
    return work;
  }

  tools(guildId: string): ToolDefinition[] {
    const { guilds, operations, messaging, plugins, quick, registry, info } =
      this.services;
    const tools: ToolDefinition[] = [];
    const add = <S extends z.ZodType>(
      name: string,
      cli: string,
      description: string,
      inputSchema: S,
      outputSchema: z.ZodType,
      run: (
        input: z.output<S>,
        context: ExecutionContext,
      ) => Promise<Record<string, unknown>>,
      readOnly = true,
    ) => {
      tools.push({
        name,
        description,
        inputSchema,
        outputSchema,
        _meta: { cli },
        annotations: {
          readOnlyHint: readOnly,
          idempotentHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: ["status", "channel_list", "message_send"].includes(
            name,
          ),
        },
        execute: (input, context) =>
          this.track(
            (async () => {
              this.assertAvailable(name === "status");
              context.signal.throwIfAborted();
              await guilds.assertGuild(guildId);
              context.signal.throwIfAborted();
              // Recheck after asynchronous installation validation, before any effect.
              this.assertAvailable(name === "status");
              return run(input as z.output<S>, context);
            })(),
          ),
      });
    };
    const mutate = async (work: Promise<void>) => {
      await work;
      return { ...guilds.snapshot(guildId) };
    };

    add(
      "status",
      "status",
      "Read this server's bot and configuration status.",
      empty,
      z.object({
        guildId: z.string(),
        service: z.string(),
        version: z.string(),
        process: commandStatusSchema,
        discord: z.object({
          state: z.string(),
          ready: z.boolean(),
          pingMs: z.number().nullable(),
        }),
        bot: z.object({ id: z.string(), username: z.string() }).nullable(),
        synchronization: z.string(),
        initialized: z.boolean(),
        writable: z.boolean(),
        commandSynchronization: commandStatusSchema,
      }),
      async () => {
        const { discord, bot } = operations.getStatus();
        const {
          synchronization,
          initialized,
          writable,
          commandSynchronization,
        } = guilds.snapshot(guildId);
        return {
          guildId,
          service: info.service,
          version: info.version,
          process: { state: this.services.processState() },
          discord,
          bot,
          synchronization,
          initialized,
          writable,
          commandSynchronization,
        };
      },
    );
    add(
      "guild_get_id",
      "guild get id",
      "Get the server ID associated with this MCP URL.",
      empty,
      z.object({ guildId: z.string() }),
      async () => ({ guildId }),
    );
    add(
      "channel_list",
      "channel list",
      "List this server's channels where the bot can send messages.",
      empty,
      z.object({
        guildId: z.string(),
        channels: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            type: z.enum(["text", "announcement"]),
          }),
        ),
      }),
      async () => ({
        guildId,
        channels: await operations.listChannels(guildId),
      }),
    );
    add(
      "message_send",
      "message send",
      "Send text to a channel belonging to this server.",
      z.strictObject({ channelId: z.string(), content: z.string() }),
      z.object({
        guildId: z.string(),
        channelId: z.string(),
        messageId: z.string(),
      }),
      async (input, context) => {
        const receipt = await messaging.send(
          {
            provider: "discord",
            kind: "guild-channel",
            guildId,
            channelId: input.channelId,
          },
          { content: input.content },
          context.signal,
        );
        return {
          guildId,
          channelId: receipt.channelId,
          messageId: receipt.messageId,
        };
      },
      false,
    );
    add(
      "command_list",
      "command list",
      "List Discord commands currently available in this server; does not execute them.",
      empty,
      z.object({
        guildId: z.string(),
        commands: z.array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            options: z.array(z.json()).optional(),
          }),
        ),
      }),
      async () => ({ guildId, commands: registry.desired(guildId) }),
    );
    add(
      "plugin_list",
      "plugin list",
      "List built-in plugins and their configuration in this server.",
      empty,
      z.object({ guildId: z.string(), plugins: z.array(pluginSchema) }),
      async () => ({ guildId, plugins: guilds.snapshot(guildId).plugins }),
    );
    add(
      "plugin_get",
      "plugin get",
      "Read a built-in plugin's configuration in this server.",
      pluginInput,
      z.object({ guildId: z.string(), plugin: pluginSchema }),
      async (input) => {
        plugins.definition(input.pluginId);
        return {
          guildId,
          plugin: guilds
            .snapshot(guildId)
            .plugins.find((plugin) => plugin.id === input.pluginId),
        };
      },
    );
    add(
      "plugin_enable",
      "plugin enable",
      "Enable a built-in plugin in this server using its confirmed revision.",
      pluginWriteInput,
      snapshotSchema,
      async (input) =>
        mutate(
          plugins.setEnabled(
            input.pluginId,
            guildId,
            true,
            input.expectedRevision,
          ),
        ),
      false,
    );
    add(
      "plugin_disable",
      "plugin disable",
      "Disable a built-in plugin in this server using its confirmed revision.",
      pluginWriteInput,
      snapshotSchema,
      async (input) =>
        mutate(
          plugins.setEnabled(
            input.pluginId,
            guildId,
            false,
            input.expectedRevision,
          ),
        ),
      false,
    );
    add(
      "plugin_configure",
      "plugin configure",
      "Configure a built-in plugin in this server. Omitted secrets are preserved; null removes a secret.",
      pluginWriteInput.extend({
        settings: z.record(z.string(), z.json()),
        secrets: z.record(z.string(), z.string().nullable()).optional(),
      }),
      snapshotSchema,
      async (input) =>
        mutate(
          plugins.configure(input.pluginId, guildId, {
            settings: input.settings,
            secrets: input.secrets,
            expectedRevision: input.expectedRevision,
          }),
        ),
      false,
    );
    add(
      "quick_command_list",
      "quick-command list",
      "List this server's Quick Commands and confirmed revisions.",
      empty,
      z.object({ guildId: z.string(), quickCommands: z.array(quickSchema) }),
      async () => ({
        guildId,
        quickCommands: guilds.snapshot(guildId).quickCommands,
      }),
    );
    add(
      "quick_command_create",
      "quick-command create",
      "Create a Quick Command in this server without overwriting an existing command.",
      quickInput,
      snapshotSchema,
      async (input) => mutate(quick.save(guildId, { guildId, ...input }, "0")),
      false,
    );
    add(
      "quick_command_update",
      "quick-command update",
      "Replace a Quick Command's response and enabled state using its confirmed revision.",
      quickInput.extend({ expectedRevision: z.string() }),
      snapshotSchema,
      async ({ expectedRevision, ...input }) =>
        mutate(quick.save(guildId, { guildId, ...input }, expectedRevision)),
      false,
    );
    add(
      "quick_command_delete",
      "quick-command delete",
      "Delete a Quick Command using its confirmed revision.",
      z.strictObject({ trigger: z.string(), expectedRevision: z.string() }),
      snapshotSchema,
      async (input) =>
        mutate(quick.delete(guildId, input.trigger, input.expectedRevision)),
      false,
    );
    return tools;
  }

  handle(
    guildId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    return this.track(this.serve(guildId, request, response));
  }

  private async serve(
    guildId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    this.assertAvailable(true);
    await this.services.guilds.assertGuild(guildId);
    if (response.destroyed) return;
    this.assertAvailable(true);
    const onerror = () => Logger.warn("MCP request failed.");
    const handler = createJsonHttpHandler({
      appId: "nox-bot",
      name: `nox-bot-${guildId}`,
      version: this.services.info.version,
      tools: this.tools(guildId),
      formatError: formatMcpError,
      onerror,
    });
    this.handlers.add(handler);
    try {
      await toNodeHandler(handler, { onerror })(request, response);
    } finally {
      this.handlers.delete(handler);
      await handler.close();
    }
  }

  stop(): Promise<void> {
    this.stopping = true;
    return (this.closing ??= Promise.allSettled([...this.active]).then(
      () => {},
    ));
  }

  forceClose(): void {
    this.stopping = true;
    for (const handler of this.handlers) void handler.close();
  }
}
