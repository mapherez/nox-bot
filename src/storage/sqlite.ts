import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  StateError,
  type StateChange,
  type StateTransport,
  type TransportCallbacks,
} from "../core/state.js";
import type {
  SqliteReply,
  SqliteRequest,
  SqliteSnapshot,
} from "./sqliteProtocol.js";
import Logger from "../utils/logger.js";

export interface SqliteConfig {
  filename: string;
}
export function loadSqliteConfig(env: NodeJS.ProcessEnv): SqliteConfig {
  const filename = env.NOX_BOT_DATABASE_PATH ?? "data/nox-bot.sqlite";
  if (!filename.trim() || filename === ":memory:" || filename.includes("\0"))
    throw new Error(
      "NOX_BOT_DATABASE_PATH must name a persistent SQLite file.",
    );
  return { filename: resolve(filename) };
}
type Request = SqliteRequest extends infer R
  ? R extends SqliteRequest
    ? Omit<R, "id">
    : never
  : never;
export class SqliteTransport implements StateTransport {
  private worker?: Worker;
  private callbacks?: TransportCallbacks;
  private requests = new Map<
    number,
    {
      resolve: (snapshot: SqliteSnapshot | undefined) => void;
      reject: (error: Error) => void;
    }
  >();
  private requestId = 0;
  private generation = 0;
  private serial: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private available = false;
  private stopped = false;
  private retry?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  constructor(
    private readonly config: SqliteConfig,
    private readonly retryMs = 1000,
  ) {}
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.serial.then(operation);
    this.serial = work.catch(() => {});
    return work;
  }
  connect(callbacks: TransportCallbacks): Promise<void> {
    this.callbacks = callbacks;
    return this.run(() => this.open());
  }
  private async open(): Promise<void> {
    if (this.stopped) return;
    this.callbacks?.recovering();
    const worker = new Worker(new URL("./sqliteWorker.js", import.meta.url), {
      execArgv: [],
      env: {},
    });
    this.worker = worker;
    const generation = ++this.generation;
    worker.on("message", (reply: SqliteReply) => {
      if (this.worker !== worker) return;
      const request = this.requests.get(reply.id);
      if (!request) return;
      this.requests.delete(reply.id);
      if ("error" in reply)
        request.reject(new StateError(reply.error.code, reply.error.message));
      else request.resolve(reply.snapshot);
    });
    worker.on("error", () => this.lost(worker));
    worker.on("exit", () => this.lost(worker));
    try {
      const snapshot = await this.request({
        type: "open",
        filename: this.config.filename,
        create: !this.initialized,
      });
      await this.publish(snapshot!, generation);
      if (this.worker === worker && !this.stopped) {
        this.available = true;
        this.initialized = true;
      }
    } catch (error) {
      this.lost(worker);
      throw error;
    }
  }
  private request(message: Request): Promise<SqliteSnapshot | undefined> {
    const worker = this.worker;
    if (!worker)
      return Promise.reject(
        new StateError("STATE_UNAVAILABLE", "SQLite is unavailable."),
      );
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try {
        worker.postMessage({ ...message, id });
      } catch {
        this.requests.delete(id);
        reject(
          new StateError("STATE_UNAVAILABLE", "SQLite worker is unavailable."),
        );
      }
    });
  }
  private async publish(snapshot: SqliteSnapshot, generation: number) {
    if (generation !== this.generation || this.stopped)
      throw new StateError(
        "WRITE_UNCONFIRMED",
        "SQLite state changed during the operation. Review the confirmed data before retrying.",
      );
    await this.callbacks!.snapshot(
      snapshot.rows,
      snapshot.sequence,
      generation,
    );
  }
  private lost(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.available = false;
    for (const pending of this.requests.values())
      pending.reject(
        new StateError(
          "WRITE_UNCONFIRMED",
          "The SQLite worker stopped before confirmation. Review the recovered data before retrying.",
        ),
      );
    this.requests.clear();
    void worker.terminate();
    if (!this.stopped) {
      this.callbacks?.disconnected();
      if (this.initialized) this.scheduleRecovery();
    }
  }
  private scheduleRecovery() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.run(() => this.open()).catch(() => {
        Logger.warn(
          "SQLite recovery is pending. Check the persistent data volume.",
        );
        this.scheduleRecovery();
      });
    }, this.retryMs);
    this.retry.unref();
  }
  mutate(changes: readonly StateChange[]): Promise<void> {
    return this.run(async () => {
      if (!this.available || this.stopped)
        throw new StateError(
          "STATE_UNAVAILABLE",
          "SQLite is unavailable. Changes are temporarily disabled.",
        );
      const worker = this.worker!,
        generation = this.generation;
      let committed = false;
      try {
        const snapshot = await this.request({ type: "mutate", changes });
        committed = true;
        await this.publish(snapshot!, generation);
      } catch (error) {
        if (
          committed ||
          !(error instanceof StateError) ||
          ["STATE_UNAVAILABLE", "WRITE_UNCONFIRMED"].includes(error.code)
        ) {
          this.lost(worker);
          throw new StateError(
            "WRITE_UNCONFIRMED",
            "SQLite could not confirm the saved state. Wait for recovery and review the data before retrying.",
          );
        }
        throw error;
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.available = false;
    clearTimeout(this.retry);
    return (this.closing = (async () => {
      await this.serial;
      const worker = this.worker;
      if (worker) {
        try {
          await this.request({ type: "close" });
        } catch {
          // A worker that exits during teardown must not prevent Discord/plugin cleanup.
        } finally {
          this.worker = undefined;
          await worker.terminate();
        }
      }
    })());
  }
}
