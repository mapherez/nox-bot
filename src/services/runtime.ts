import { isIP } from "node:net";
import { AuthService, DiscordOAuth, loadAuthConfig } from "../core/auth.js";
import { StateStore } from "../core/state.js";
import { SecretVault } from "../core/secrets.js";
import { MessagingService } from "../core/messaging.js";
import { QuickCommandService } from "../core/quickCommands.js";
import { CommandRegistry } from "../core/commandRegistry.js";
import {
  SpacetimeTransport,
  loadSpacetimeConfig,
} from "../storage/spacetime.js";
import { PluginManager } from "../plugins/manager.js";
import { builtInPlugins } from "../plugins/catalog.js";
import { loadControlApiConfig, type ProcessState } from "../controlApi.js";
import {
  createServiceInfo,
  resolveRuntimeVersion,
} from "../utils/runtimeVersion.js";
import Logger from "../utils/logger.js";
import Bot from "./bot.js";
import DiscordOperations from "./discordOperations.js";
import ControlApi from "./controlApi.js";
import { DashboardServer } from "./dashboard.js";
import { CommandReconciler } from "./commandReconciler.js";
import { InteractionRouter } from "./interactionRouter.js";

export interface ManagedRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  forceClose(): void;
}
export class Runtime implements ManagedRuntime {
  private bot: Bot;
  private state: StateStore;
  private plugins: PluginManager;
  private dashboard: DashboardServer;
  private api?: ControlApi;
  private reconciler: CommandReconciler;
  private auth: AuthService;
  private stopped = false;
  private fingerprints = new Map<string, string>();
  private commandStates = new Map<string, { state: string; error?: string }>();
  private timer?: ReturnType<typeof setInterval>;
  private initializing = true;
  private teardown?: Promise<void>;
  private cancelStart?: () => void;
  private dashboardStarted = false;
  private apiStarted = false;
  private dashboardListening?: Promise<void>;
  private apiListening?: Promise<void>;
  private globalsPending = true;
  private recoveryPending = true;
  static async create(
    env: NodeJS.ProcessEnv,
    processState: () => ProcessState,
    fatal: (error: unknown) => void,
  ): Promise<Runtime> {
    const authConfig = loadAuthConfig(env),
      storage = await loadSpacetimeConfig(env),
      apiConfig = loadControlApiConfig(env);
    const port = Number(env.NOX_BOT_DASHBOARD_PORT ?? 3200),
      host = env.NOX_BOT_DASHBOARD_HOST ?? "127.0.0.1";
    if (
      (!isIP(host) && host !== "localhost") ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error("Invalid dashboard listener configuration.");
    const vault = new SecretVault(env.NOX_BOT_ENCRYPTION_KEY ?? "");
    const info = createServiceInfo(await resolveRuntimeVersion(env));
    return new Runtime(
      env,
      authConfig,
      storage,
      apiConfig,
      vault,
      info,
      { host, port },
      processState,
      fatal,
    );
  }
  private constructor(
    private readonly env: NodeJS.ProcessEnv,
    authConfig: ReturnType<typeof loadAuthConfig>,
    storage: Awaited<ReturnType<typeof loadSpacetimeConfig>>,
    apiConfig: ReturnType<typeof loadControlApiConfig>,
    vault: SecretVault,
    info: ReturnType<typeof createServiceInfo>,
    listener: { host: string; port: number },
    processState: () => ProcessState,
    fatal: (error: unknown) => void,
  ) {
    this.bot = new Bot();
    const operations = new DiscordOperations(this.bot.client),
      messaging = new MessagingService([operations]);
    this.state = new StateStore(new SpacetimeTransport(storage));
    this.plugins = new PluginManager(
      this.state,
      vault,
      builtInPlugins,
      () => new Set(this.bot.client.guilds.cache.keys()),
    );
    const quick = new QuickCommandService(this.state),
      registry = new CommandRegistry(this.plugins);
    this.auth = new AuthService(
      this.state,
      authConfig,
      new DiscordOAuth(authConfig),
    );
    this.reconciler = CommandReconciler.discord(
      env.DISCORD_TOKEN!,
      env.DISCORD_CLIENT_ID!,
      registry,
    );
    this.bot.attach(
      new InteractionRouter(
        this.bot.client,
        registry,
        this.plugins,
        quick,
        messaging,
      ),
      quick,
      messaging,
    );
    this.dashboard = new DashboardServer(
      listener,
      this.auth,
      this.state,
      operations,
      this.plugins,
      quick,
      (id) => this.commandStates.get(id) ?? { state: "pending" },
    );
    if (apiConfig.enabled)
      this.api = new ControlApi(
        apiConfig,
        operations,
        info,
        processState,
        fatal,
      );
    const reconcile = async (force = false) => {
      await Promise.all(
        [...this.bot.client.guilds.cache.keys()].map(async (guildId) => {
          const fingerprint = JSON.stringify(registry.desired(guildId));
          if (!force && this.fingerprints.get(guildId) === fingerprint) return;
          this.commandStates.set(guildId, { state: "syncing" });
          try {
            await this.reconciler.reconcile(guildId);
            this.fingerprints.set(guildId, fingerprint);
            this.commandStates.set(guildId, { state: "synced" });
          } catch {
            this.commandStates.set(guildId, {
              state: "error",
              error: "Discord command synchronization will be retried.",
            });
            Logger.warn("Discord command synchronization is pending.");
          }
        }),
      );
    };
    this.state.on("sync", (synchronization) => {
      if (synchronization === "reconnecting") this.recoveryPending = true;
    });
    this.state.addProjection(async () => {
      await reconcile(this.recoveryPending);
      this.recoveryPending = false;
    });
    this.plugins.on("change", () => {
      if (!this.initializing) void reconcile();
    });
    const guildChange = () => {
      if (!this.state.initialized || this.stopped) return;
      void this.plugins.synchronize().then(() => reconcile(true));
    };
    this.bot.on("guildCreate", guildChange);
    this.bot.on("guildDelete", guildChange);
    this.bot.on("guildAvailable", guildChange);
    this.bot.on("shardResume", () => {
      if (this.state.initialized) void reconcile(true);
    });
    this.timer = setInterval(
      () => {
        if (this.state.initialized && !this.stopped) {
          void this.cleanGlobals();
          void reconcile(true);
        }
      },
      5 * 60 * 1000,
    );
    this.timer.unref();
  }
  async start(): Promise<void> {
    const cancelled = new Promise<void>((resolve) => {
      this.cancelStart = resolve;
    });
    const initialize = async () => {
      this.dashboardListening = this.dashboard.start();
      await this.dashboardListening;
      this.dashboardStarted = true;
      if (this.stopped) return;
      if (this.api) {
        this.apiListening = this.api.start();
        await this.apiListening;
        this.apiStarted = true;
      }
      if (this.stopped) return;
      await this.bot.login(this.env.DISCORD_TOKEN!);
      if (this.stopped) return;
      await this.cleanGlobals();
      if (this.stopped) return;
      await this.state.start();
      if (this.stopped) return;
      await this.auth.initializeOwner();
      if (this.stopped) return;
      this.initializing = false;
    };
    await Promise.race([initialize(), cancelled]);
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.cancelStart?.();
    clearInterval(this.timer);
    return (this.teardown ??= (async () => {
      await Promise.allSettled(
        [this.dashboardListening, this.apiListening].filter(
          (work): work is Promise<void> => !!work,
        ),
      );
      await Promise.allSettled([
        this.dashboardStarted ? this.dashboard.stop() : Promise.resolve(),
        this.apiStarted ? this.api!.stop() : Promise.resolve(),
      ]);
      await this.state.close();
      await this.plugins.close();
      await this.reconciler.close();
      await this.bot.destroy();
    })());
  }
  private async cleanGlobals(): Promise<void> {
    if (!this.globalsPending || this.stopped) return;
    try {
      await this.reconciler.cleanGlobalRegistrations();
      this.globalsPending = false;
    } catch {
      Logger.warn("Legacy global command cleanup will be retried.");
    }
  }
  forceClose(): void {
    this.dashboard.forceClose();
    this.api?.forceClose();
    this.plugins.forceClose();
    void this.state.close();
    void this.bot.destroy();
  }
}
