import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateId } from "../controlApi.js";
import {
  isRecord,
  type GuildPlugin,
  type Settings,
  type StateStore,
} from "../core/state.js";
import type { SecretVault } from "../core/secrets.js";
import type {
  ChildMessage,
  ParentMessage,
  PluginContext,
  PluginDefinition,
  RichContent,
} from "./sdk.js";
import Logger from "../utils/logger.js";
import { validateRichContent } from "./richContent.js";

export type RuntimeState =
  "inactive" | "starting" | "active" | "error" | "stopping";
type Reply = Extract<ChildMessage, { type: "result" }>["value"];
type Request = ParentMessage extends infer M
  ? M extends ParentMessage
    ? Omit<M, "requestId">
    : never
  : never;

class PluginProcess {
  private readonly child: ChildProcess;
  private pending = new Map<
    string,
    {
      resolve: (value: Reply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private disposed = false;
  private exited = false;
  constructor(onCrash: () => void, launch: typeof fork) {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
    for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"])
      if (process.env[name]) env[name] = process.env[name];
    this.child = launch(
      fileURLToPath(new URL("./worker.js", import.meta.url)),
      [],
      {
        env,
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    this.child.on("message", (message: unknown) => {
      if (!isRecord(message) || typeof message.requestId !== "string") return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.type === "result")
        pending.resolve((message as ChildMessage & { type: "result" }).value);
      else pending.reject(new Error("Plugin operation failed."));
    });
    this.child.on("error", () => this.fail());
    this.child.once("exit", () => {
      this.exited = true;
      this.fail();
      if (!this.disposed) onCrash();
    });
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  forceStop(): void {
    this.disposed = true;
    this.fail();
    this.child.kill("SIGKILL");
  }
  private fail(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Plugin runtime is unavailable."));
    }
    this.pending.clear();
  }
  request(request: Request, timeoutMs = 20000): Promise<Reply> {
    if (!this.child.connected || this.exited)
      return Promise.reject(new Error("Plugin runtime is unavailable."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Plugin operation timed out."));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ ...request, requestId }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          reject(new Error("Plugin runtime is unavailable."));
        }
      });
    });
  }
  async stop(): Promise<void> {
    this.disposed = true;
    try {
      if (this.child.connected && !this.exited)
        await this.request({ type: "dispose" }, 1500);
    } catch {
      /* Hard teardown still follows. */
    }
    if (!this.exited) {
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(() => {
          this.child.kill("SIGKILL");
        }, 1500);
        this.child.once("exit", () => {
          clearTimeout(deadline);
          resolve();
        });
        this.child.kill();
      });
    }
    this.fail();
    this.child.removeAllListeners();
  }
}
interface ManagedPlugin {
  definition: PluginDefinition;
  process?: PluginProcess;
  guilds: Set<string>;
  status: RuntimeState;
  retries: number;
  retry?: ReturnType<typeof setTimeout>;
  error?: string;
  validated?: boolean;
}

export class PluginManager extends EventEmitter {
  private readonly plugins = new Map<string, ManagedPlugin>();
  private serial = Promise.resolve();
  private stopping = false;
  private detach: () => void;
  constructor(
    private readonly state: StateStore,
    private readonly vault: SecretVault,
    definitions: readonly PluginDefinition[],
    private readonly installedGuilds: () => ReadonlySet<string>,
    private readonly launch: typeof fork = fork,
  ) {
    super();
    const commands = new Set(["nox"]);
    for (const definition of definitions) {
      if (
        !/^[a-z][a-z0-9-]{0,31}$/.test(definition.id) ||
        this.plugins.has(definition.id) ||
        !definition.name ||
        !definition.description ||
        !/^\d+\.\d+\.\d+$/.test(definition.version) ||
        !definition.icon ||
        !definition.dashboardEntry ||
        !/^\.\/[a-z0-9-]+\/runtime\.js$/.test(definition.runtimeEntry) ||
        definition.commands.length === 0 ||
        typeof definition.validateSettings !== "function" ||
        typeof definition.validateSecrets !== "function"
      )
        throw new Error("Invalid plugin definition.");
      if (
        definition.capabilities.some(
          (value) =>
            !["http", "attachments", "discord-users", "interactive"].includes(
              value,
            ),
        ) ||
        new Set(definition.secretFields).size !== definition.secretFields.length
      )
        throw new Error("Invalid plugin capabilities or secret fields.");
      if (
        definition.componentHandlers?.some(
          (handler) => !/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(handler),
        ) ||
        new Set(definition.componentHandlers).size !==
          (definition.componentHandlers?.length ?? 0) ||
        (definition.componentHandlers?.length &&
          !definition.capabilities.includes("interactive"))
      )
        throw new Error("Invalid interactive handler declaration.");
      definition.validateSettings(definition.defaults);
      for (const command of definition.commands) {
        if (
          !/^[a-z][a-z0-9_-]{0,31}$/.test(command.name) ||
          commands.has(command.name) ||
          !command.handler ||
          !command.usage ||
          !command.description ||
          command.description.length > 100 ||
          (command.options?.length ?? 0) > 25
        )
          throw new Error("Invalid or colliding plugin command.");
        const options = new Set<string>();
        let optionalSeen = false;
        for (const option of command.options ?? []) {
          if (
            options.has(option.name) ||
            !/^[a-z][a-z0-9_-]{0,31}$/.test(option.name) ||
            !option.description ||
            option.description.length > 100
          )
            throw new Error("Invalid command option.");
          options.add(option.name);
          if ("required" in option && option.required && optionalSeen)
            throw new Error(
              "Required command options must precede optional options.",
            );
          if (!("required" in option) || !option.required) optionalSeen = true;
          if (
            "autocomplete" in option &&
            option.autocomplete &&
            "choices" in option &&
            option.choices?.length
          )
            throw new Error("Autocomplete options cannot declare choices.");
        }
        commands.add(command.name);
      }
      this.plugins.set(definition.id, {
        definition,
        guilds: new Set(),
        status: "inactive",
        retries: 0,
      });
    }
    this.detach = state.addProjection(() => this.synchronize());
  }
  definitions(): PluginDefinition[] {
    return [...this.plugins.values()].map((p) => p.definition);
  }
  definition(id: string): PluginDefinition {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error("Unknown built-in plugin.");
    return plugin.definition;
  }
  isActive(id: string, guildId: string): boolean {
    const plugin = this.plugins.get(id);
    return !!plugin && plugin.status === "active" && plugin.guilds.has(guildId);
  }
  commandsAvailable(id: string, guildId: string): boolean {
    const plugin = this.plugins.get(id);
    return (
      !!plugin?.validated &&
      plugin.guilds.has(guildId) &&
      !!this.state.get("plugin", guildId, id)?.data.enabled
    );
  }
  runtimeStatus(id: string) {
    const plugin = this.plugins.get(id);
    return {
      state: plugin?.status ?? "inactive",
      pid: plugin?.process?.pid,
      guildCount: plugin?.guilds.size ?? 0,
      error: plugin?.error,
    };
  }
  configuration(id: string, guildId: string) {
    const definition = this.definition(id),
      stored = this.state.get("plugin", guildId, id);
    return {
      revision: stored?.revision ?? "0",
      enabled: stored?.data.enabled ?? false,
      settings: stored?.data.settings ?? structuredClone(definition.defaults),
      secrets: Object.fromEntries(
        definition.secretFields.map((field) => [
          field,
          { configured: !!stored?.data.secrets[field] },
        ]),
      ),
      runtime:
        stored?.data.enabled && this.installedGuilds().has(guildId)
          ? this.runtimeStatus(id).state
          : "inactive",
      error: stored?.data.enabled ? this.runtimeStatus(id).error : undefined,
    };
  }
  private decrypt(
    definition: PluginDefinition,
    config: GuildPlugin,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(config.secrets).map(([field, value]) => [
        field,
        this.vault.decrypt(value, config.guildId, definition.id, field),
      ]),
    );
  }
  async configure(
    id: string,
    guildId: string,
    input: {
      settings: unknown;
      secrets?: Record<string, string | null>;
      expectedRevision: string;
    },
  ): Promise<void> {
    validateId(guildId);
    if (!this.installedGuilds().has(guildId))
      throw new Error("Bot is not installed in this server.");
    const definition = this.definition(id),
      previous = this.state.get("plugin", guildId, id)?.data;
    const secrets = { ...previous?.secrets };
    for (const [field, value] of Object.entries(input.secrets ?? {})) {
      if (
        !definition.secretFields.includes(field) ||
        (value !== null &&
          (typeof value !== "string" || !value.trim() || value.length > 4096))
      )
        throw new Error("Invalid plugin secret.");
      if (value === null) delete secrets[field];
      else
        secrets[field] = this.vault.encrypt(value.trim(), guildId, id, field);
    }
    const config: GuildPlugin = {
      guildId,
      pluginId: id,
      enabled: previous?.enabled ?? false,
      settings: definition.validateSettings(input.settings),
      secrets,
    };
    if (config.enabled)
      definition.validateSecrets(this.decrypt(definition, config));
    await this.state.put("plugin", guildId, id, config, input.expectedRevision);
  }
  async setEnabled(
    id: string,
    guildId: string,
    enabled: boolean,
    expectedRevision: string,
  ): Promise<void> {
    validateId(guildId);
    if (!this.installedGuilds().has(guildId))
      throw new Error("Bot is not installed in this server.");
    const definition = this.definition(id),
      previous = this.state.get("plugin", guildId, id)?.data;
    const config: GuildPlugin = {
      guildId,
      pluginId: id,
      enabled,
      settings: definition.validateSettings(
        previous?.settings ?? definition.defaults,
      ),
      secrets: { ...previous?.secrets },
    };
    if (enabled) definition.validateSecrets(this.decrypt(definition, config));
    await this.state.put("plugin", guildId, id, config, expectedRevision);
  }
  synchronize(): Promise<void> {
    const work = this.serial.then(() => this.apply());
    this.serial = work.catch(() => {});
    return work;
  }
  private async apply(): Promise<void> {
    if (this.stopping) return;
    const installed = this.installedGuilds();
    for (const plugin of this.plugins.values()) {
      const desired = new Set(
        this.state
          .list("plugin")
          .filter(
            (row) =>
              row.data.pluginId === plugin.definition.id &&
              row.data.enabled &&
              installed.has(row.data.guildId),
          )
          .map((row) => row.data.guildId),
      );
      const changed =
        [...desired].sort().join(",") !== [...plugin.guilds].sort().join(",");
      if (!desired.size) {
        clearTimeout(plugin.retry);
        plugin.retry = undefined;
        plugin.guilds = desired;
        if (plugin.process) {
          plugin.status = "stopping";
          await plugin.process.stop();
          plugin.process = undefined;
        }
        plugin.status = "inactive";
        plugin.error = undefined;
        plugin.retries = 0;
        continue;
      }
      try {
        for (const guildId of desired) {
          const config = this.state.get(
            "plugin",
            guildId,
            plugin.definition.id,
          )!.data;
          plugin.definition.validateSettings(config.settings);
          plugin.definition.validateSecrets(
            this.decrypt(plugin.definition, config),
          );
        }
        plugin.guilds = desired;
        if (!plugin.process && plugin.status !== "error" && !plugin.retry)
          await this.activate(plugin);
        else if (plugin.process && changed)
          await plugin.process.request({
            type: "configure",
            guilds: [...desired],
          });
      } catch {
        plugin.status = "error";
        plugin.error =
          "Plugin configuration or runtime could not be activated.";
        if (plugin.process) {
          await plugin.process.stop();
          plugin.process = undefined;
        }
      }
    }
    this.emit("change");
  }
  private async activate(plugin: ManagedPlugin): Promise<void> {
    await access(
      fileURLToPath(new URL(plugin.definition.runtimeEntry, import.meta.url)),
    );
    plugin.status = "starting";
    plugin.error = undefined;
    const child = new PluginProcess(
      () => this.crashed(plugin, child),
      this.launch,
    );
    plugin.process = child;
    await child.request(
      {
        type: "initialize",
        entry: fileURLToPath(
          new URL(plugin.definition.runtimeEntry, import.meta.url),
        ),
        handlers: plugin.definition.commands.map((c) => c.handler),
        componentHandlers: plugin.definition.componentHandlers ?? [],
        guilds: [...plugin.guilds],
      },
      10000,
    );
    if (plugin.process === child) {
      plugin.status = "active";
      plugin.validated = true;
    }
  }
  private crashed(plugin: ManagedPlugin, process: PluginProcess): void {
    if (this.stopping || plugin.process !== process) return;
    plugin.process = undefined;
    plugin.status = "error";
    plugin.error = "Plugin runtime stopped unexpectedly.";
    this.emit("change");
    this.scheduleRecovery(plugin);
  }
  private scheduleRecovery(plugin: ManagedPlugin): void {
    if (
      this.stopping ||
      !plugin.guilds.size ||
      plugin.retries >= 3 ||
      plugin.retry
    )
      return;
    const delay = 1000 * 2 ** plugin.retries++;
    plugin.retry = setTimeout(() => {
      plugin.retry = undefined;
      const retry = this.serial.then(async () => {
        if (this.stopping || !plugin.guilds.size) return;
        try {
          await this.activate(plugin);
          this.emit("change");
        } catch {
          if (plugin.process) {
            await plugin.process.stop();
            plugin.process = undefined;
          }
          plugin.status = "error";
          plugin.error = "Plugin recovery failed.";
          this.emit("change");
          this.scheduleRecovery(plugin);
        }
      });
      this.serial = retry.catch(() => {});
    }, delay);
  }
  async execute(
    id: string,
    handler: string,
    context: Omit<PluginContext, "settings" | "secrets">,
    type: "execute" | "component" | "autocomplete" = "execute",
  ): Promise<Reply> {
    if (!this.isActive(id, context.guildId))
      throw new Error("Plugin is not enabled in this server.");
    const plugin = this.plugins.get(id)!,
      config = this.state.get("plugin", context.guildId, id)!.data;
    const fullContext: PluginContext = {
      ...context,
      settings: config.settings,
      secrets: this.decrypt(plugin.definition, config),
    };
    if (!plugin.definition.capabilities.includes("discord-users"))
      fullContext.users = {};
    const result = await plugin.process!.request({
      type,
      handler,
      context: fullContext,
    });
    if (type === "autocomplete") {
      if (
        !Array.isArray(result) ||
        result.length > 25 ||
        result.some(
          (option) =>
            !isRecord(option) ||
            typeof option.name !== "string" ||
            option.name.length > 100 ||
            !["string", "number"].includes(typeof option.value),
        )
      )
        throw new Error("Invalid autocomplete response.");
    } else validateRichContent(result, plugin.definition);
    return result;
  }
  async close(): Promise<void> {
    this.stopping = true;
    this.detach();
    for (const plugin of this.plugins.values()) clearTimeout(plugin.retry);
    await this.serial;
    await Promise.all(
      [...this.plugins.values()].map(async (plugin) => {
        await plugin.process?.stop();
        plugin.process = undefined;
        plugin.status = "inactive";
      }),
    );
    this.removeAllListeners();
    Logger.info("Built-in plugin runtimes stopped.");
  }
  forceClose(): void {
    this.stopping = true;
    this.detach();
    for (const plugin of this.plugins.values()) {
      clearTimeout(plugin.retry);
      plugin.process?.forceStop();
    }
  }
}
