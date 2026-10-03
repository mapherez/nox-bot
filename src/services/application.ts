import type { GatewayIntentBits, SlashCommandBuilder } from "discord.js";
import { loadControlApiConfig, type ControlApiConfig, type DiscordOperationsContract, type ProcessState, type ServiceInfo } from "../controlApi.js";
import { createServiceInfo, resolveRuntimeVersion } from "../utils/runtimeVersion.js";
import { createSlashCommands, getClientIntents } from "../utils/commandLoader.js";
import EnvironmentValidator from "../utils/environmentValidator.js";
import Logger from "../utils/logger.js";
import Bot from "./bot.js";
import CommandHandler from "./commandHandler.js";
import CommandRegistrar from "./commandRegistrar.js";
import DiscordOperations from "./discordOperations.js";
import ControlApi from "./controlApi.js";

type ManagedBot = Pick<Bot, "client" | "setCommandHandler" | "login" | "destroy">;
type ManagedApi = Pick<ControlApi, "start" | "stop" | "forceClose">;
export interface ApplicationDependencies {
  loadIntents(): Promise<GatewayIntentBits[]>;
  loadCommands(): Promise<SlashCommandBuilder[]>;
  createBot(intents: GatewayIntentBits[]): ManagedBot;
  createHandler(): Pick<CommandHandler, "initialize">;
  createRegistrar(token: string, clientId: string, guilds: string[]): Pick<CommandRegistrar, "registerCommands">;
  createOperations(bot: ManagedBot): DiscordOperationsContract;
  createApi(config: ControlApiConfig, operations: DiscordOperationsContract, info: ServiceInfo,
    state: () => ProcessState, onFatal: (error: unknown) => void): ManagedApi;
}

const defaults: ApplicationDependencies = {
  loadIntents: getClientIntents,
  loadCommands: createSlashCommands,
  createBot: (intents) => new Bot(intents),
  createHandler: () => new CommandHandler(),
  createRegistrar: (token, id, guilds) => new CommandRegistrar(token, id, guilds),
  createOperations: (bot) => new DiscordOperations(bot.client),
  createApi: (config, operations, info, state, onFatal) => new ControlApi(config, operations, info, state, onFatal),
};

export default class Application {
  private state: ProcessState = "starting";
  private bot?: ManagedBot;
  private api?: ManagedApi;
  private startup?: Promise<void>;
  private shutdown?: Promise<void>;
  private botDestruction?: Promise<void>;
  private readonly dependencies: ApplicationDependencies;
  private exitCode = 0;
  private terminating?: Promise<void>;
  private readonly listeners = new Map<string, (...args: any[]) => void>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    dependencies: Partial<ApplicationDependencies> = {},
    private readonly exit: (code: number) => void = (code) => process.exit(code),
    private readonly shutdownTimeoutMs = 10_000,
  ) { this.dependencies = { ...defaults, ...dependencies }; }

  getState(): ProcessState { return this.state; }

  start(): Promise<void> {
    if (this.state === "stopping") return Promise.reject(new Error("Application is stopping."));
    if (!this.startup) this.startup = this.initialize();
    return this.startup;
  }

  private installListeners(): void {
    const terminate = (code: number, message: string, error?: unknown) => {
      if (error !== undefined) Logger.error(message, error); else Logger.info(message);
      void this.terminate(code);
    };
    this.listeners.set("SIGINT", () => terminate(0, "Received SIGINT, shutting down gracefully..."));
    this.listeners.set("SIGTERM", () => terminate(0, "Received SIGTERM, shutting down gracefully..."));
    this.listeners.set("uncaughtException", (error: unknown) => terminate(1, "Uncaught exception:", error));
    this.listeners.set("unhandledRejection", (reason: unknown) => terminate(1, "Unhandled rejection:", reason));
    for (const [event, listener] of this.listeners) process.on(event, listener);
  }

  private terminate(code: number): Promise<void> {
    this.exitCode = Math.max(this.exitCode, code);
    if (!this.terminating) this.terminating = this.stop().then(() => this.exit(this.exitCode));
    return this.terminating;
  }

  private async initialize(): Promise<void> {
    try {
      EnvironmentValidator.validate(this.env);
      const config = loadControlApiConfig(this.env);
      this.installListeners();
      const info = createServiceInfo(await resolveRuntimeVersion(this.env));
      if (this.getState() === "stopping") return;
      Logger.info(`Starting Discord bot (${info.version})...`);
      const intents = await this.dependencies.loadIntents();
      if (this.getState() === "stopping") return;
      this.bot = this.dependencies.createBot(intents);
      if (config.enabled) {
        const operations = this.dependencies.createOperations(this.bot);
        this.api = this.dependencies.createApi(config, operations, info, () => this.state, (error) => {
          Logger.error("Control API server failed:", error);
          void this.terminate(1);
        });
        await this.api.start();
        if (this.getState() === "stopping") return;
        Logger.info("Control API listening.");
      }
      const commands = await this.dependencies.loadCommands();
      if (this.getState() === "stopping") return;
      const handler = this.dependencies.createHandler();
      await handler.initialize();
      if (this.getState() === "stopping") return;
      const registrar = this.dependencies.createRegistrar(this.env.DISCORD_TOKEN!, this.env.CLIENT_ID!, this.env.GUILD_ID ? [this.env.GUILD_ID] : []);
      this.bot.setCommandHandler(handler);
      await registrar.registerCommands(commands);
      if (this.getState() === "stopping") return;
      await this.bot.login(this.env.DISCORD_TOKEN!);
      if (this.getState() === "stopping") return;
      this.state = "running";
      Logger.success("Bot started successfully!");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  stop(): Promise<void> {
    this.state = "stopping";
    if (!this.shutdown) this.shutdown = this.cleanup();
    return this.shutdown;
  }

  private async cleanup(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const destroyBot = () => this.botDestruction ??= Promise.resolve().then(() => this.bot?.destroy()).catch((error) => {
      this.exitCode = 1;
      Logger.error("Bot shutdown failed:", error);
    });
    const graceful = async () => {
      try { await this.api?.stop(); }
      catch (error) { this.exitCode = 1; Logger.error("Control API shutdown failed:", error); }
      finally { await destroyBot(); }
    };
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        Logger.warn("Shutdown deadline reached; closing remaining connections.");
        this.api?.forceClose();
        void destroyBot();
        resolve();
      }, this.shutdownTimeoutMs);
    });
    try { await Promise.race([graceful(), deadline]); }
    finally {
      clearTimeout(timer);
      for (const [event, listener] of this.listeners) process.off(event, listener);
      this.listeners.clear();
    }
  }
}
