import type { ProcessState } from "../controlApi.js";
import EnvironmentValidator from "../utils/environmentValidator.js";
import Logger from "../utils/logger.js";
import { Runtime, type ManagedRuntime } from "./runtime.js";

export interface ApplicationDependencies {
  createRuntime(
    env: NodeJS.ProcessEnv,
    state: () => ProcessState,
    fatal: (error: unknown) => void,
  ): Promise<ManagedRuntime>;
}
export default class Application {
  private state: ProcessState = "starting";
  private runtime?: ManagedRuntime;
  private startup?: Promise<void>;
  private shutdown?: Promise<void>;
  private terminating?: Promise<void>;
  private exitCode = 0;
  private listeners = new Map<string, (...args: unknown[]) => void>();
  private readonly dependencies: ApplicationDependencies;
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    dependencies: Partial<ApplicationDependencies> = {},
    private readonly exit: (code: number) => void = (code) =>
      process.exit(code),
    private readonly shutdownTimeoutMs = 10000,
  ) {
    this.dependencies = { createRuntime: Runtime.create, ...dependencies };
  }
  getState(): ProcessState {
    return this.state;
  }
  start(): Promise<void> {
    if (this.state === "stopping")
      return Promise.reject(new Error("Application is stopping."));
    return (this.startup ??= this.initialize());
  }
  private terminate(code: number): Promise<void> {
    this.exitCode = Math.max(this.exitCode, code);
    return (this.terminating ??= this.stop().then(() =>
      this.exit(this.exitCode),
    ));
  }
  private async initialize(): Promise<void> {
    try {
      EnvironmentValidator.validate(this.env);
      const terminate = (code: number, message: string) => {
        Logger.info(message);
        void this.terminate(code);
      };
      this.listeners.set("SIGINT", () =>
        terminate(0, "Received SIGINT; shutting down."),
      );
      this.listeners.set("SIGTERM", () =>
        terminate(0, "Received SIGTERM; shutting down."),
      );
      this.listeners.set("uncaughtException", () =>
        terminate(1, "Uncaught exception; shutting down."),
      );
      this.listeners.set("unhandledRejection", () =>
        terminate(1, "Unhandled rejection; shutting down."),
      );
      for (const [event, listener] of this.listeners)
        process.on(event, listener);
      this.runtime = await this.dependencies.createRuntime(
        this.env,
        () => this.state,
        (error) => {
          Logger.error("Runtime failed:", error);
          void this.terminate(1);
        },
      );
      if (this.state === "stopping") {
        await this.runtime.stop();
        return;
      }
      await this.runtime.start();
      if (this.getState() !== "stopping") {
        this.state = "running";
        Logger.success("NoX Bot started with confirmed configuration.");
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  stop(): Promise<void> {
    this.state = "stopping";
    return (this.shutdown ??= this.cleanup());
  }
  private async cleanup(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.runtime?.stop(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            Logger.warn("Shutdown deadline reached.");
            this.runtime?.forceClose();
            resolve();
          }, this.shutdownTimeoutMs);
        }),
      ]);
    } catch {
      this.exitCode = 1;
      Logger.error("Runtime cleanup failed.");
    } finally {
      clearTimeout(timer);
      for (const [event, listener] of this.listeners)
        process.off(event, listener);
      this.listeners.clear();
    }
  }
}
