import { readFile } from "node:fs/promises";
import { DbConnection, tables } from "./bindings/index.js";
import {
  StateError,
  type StateChange,
  type StateTransport,
  type TransportCallbacks,
} from "../core/state.js";
import Logger, { registerSecret } from "../utils/logger.js";

export interface SpacetimeConfig {
  url: string;
  database: string;
  token: string;
}
export async function loadSpacetimeConfig(
  env: NodeJS.ProcessEnv,
): Promise<SpacetimeConfig> {
  let token = env.NOX_BOT_SPACETIMEDB_TOKEN;
  if (!token && env.NOX_BOT_STATE_CREDENTIAL_FILE) {
    const value: unknown = JSON.parse(
      await readFile(env.NOX_BOT_STATE_CREDENTIAL_FILE, "utf8"),
    );
    if (
      value &&
      typeof value === "object" &&
      "service" in value &&
      value.service &&
      typeof value.service === "object" &&
      "token" in value.service &&
      typeof value.service.token === "string"
    )
      token = value.service.token;
  }
  if (!token)
    throw new Error(
      "SpacetimeDB service credentials are required. Run the state initializer.",
    );
  registerSecret(token);
  return {
    url: env.NOX_BOT_SPACETIMEDB_URL ?? "http://127.0.0.1:3300",
    database: env.NOX_BOT_SPACETIMEDB_DATABASE ?? "nox-bot",
    token,
  };
}

export class SpacetimeTransport implements StateTransport {
  private connection?: DbConnection;
  private callbacks?: TransportCallbacks;
  private generation = 0;
  private stopped = false;
  private subscribed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private flushQueued = false;
  private publishing = Promise.resolve();
  private waiters = new Set<{
    check: () => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private initialResolve?: () => void;
  constructor(
    private readonly config: SpacetimeConfig,
    private readonly retryMs = 1000,
  ) {}
  connect(callbacks: TransportCallbacks): Promise<void> {
    this.callbacks = callbacks;
    return new Promise((resolve) => {
      this.initialResolve = resolve;
      this.open();
    });
  }
  private open(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    this.subscribed = false;
    this.callbacks?.recovering();
    this.connection = DbConnection.builder()
      .withUri(this.config.url)
      .withDatabaseName(this.config.database)
      .withToken(this.config.token)
      .withConfirmedReads(true)
      .onConnect((conn) => {
        if (generation !== this.generation || this.stopped) {
          conn.disconnect();
          return;
        }
        const notify = () => this.queueSnapshot(conn, generation);
        conn.db.serviceDocuments.onInsert(notify);
        conn.db.serviceDocuments.onUpdate(notify);
        conn.db.serviceDocuments.onDelete(notify);
        conn.db.serviceSequence.onInsert(notify);
        conn.db.serviceSequence.onUpdate(notify);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            this.subscribed = true;
            if (![...conn.db.serviceSequence.iter()].length) {
              this.lost(generation);
              conn.disconnect();
              return;
            }
            notify();
          })
          .onError(() => {
            this.lost(generation);
            conn.disconnect();
          })
          .subscribe([tables.serviceDocuments, tables.serviceSequence]);
      })
      .onConnectError(() => this.lost(generation))
      .onDisconnect(() => this.lost(generation))
      .build();
  }
  private lost(generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    ++this.generation;
    this.subscribed = false;
    this.callbacks?.disconnected();
    for (const waiter of this.waiters)
      waiter.reject(
        new StateError(
          "WRITE_UNCONFIRMED",
          "The write outcome is unknown. It will be resolved after synchronization recovers.",
        ),
      );
    this.waiters.clear();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.open(), this.retryMs);
  }
  private queueSnapshot(conn: DbConnection, generation: number): void {
    if (!this.subscribed || this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      if (!this.subscribed || generation !== this.generation || this.stopped)
        return;
      const rows = [...conn.db.serviceDocuments.iter()];
      const sequence = [...conn.db.serviceSequence.iter()][0]?.revision;
      if (sequence === undefined) return;
      this.publishing = this.publishing
        .then(async () => {
          if (generation !== this.generation || this.stopped) return;
          await this.callbacks?.snapshot(rows, sequence, generation);
          if (generation !== this.generation || this.stopped) return;
          this.initialResolve?.();
          this.initialResolve = undefined;
          for (const waiter of this.waiters)
            if (waiter.check()) {
              waiter.resolve();
              this.waiters.delete(waiter);
            }
        })
        .catch(() => {
          Logger.error(
            "State projection failed; retaining confirmed runtime configuration.",
          );
          this.lost(generation);
        });
    });
  }
  async mutate(changes: readonly StateChange[]): Promise<void> {
    const conn = this.connection,
      generation = this.generation;
    if (!conn?.isActive || !this.subscribed)
      throw new StateError(
        "STATE_UNAVAILABLE",
        "State synchronization is unavailable.",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let acknowledged = false;
    const confirmed = new Promise<void>((resolve, reject) => {
      const waiter = {
        check: () => {
          if (!acknowledged || generation !== this.generation) return false;
          const rows = new Map(
            [...conn.db.serviceDocuments.iter()].map((row) => [row.key, row]),
          );
          return changes.every((c) =>
            c.value === null
              ? !rows.has(c.key)
              : (rows.get(c.key)?.revision ?? 0n) > c.expectedRevision &&
                rows.get(c.key)?.value === c.value,
          );
        },
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(
          new StateError(
            "WRITE_UNCONFIRMED",
            "The write has not been confirmed. Refresh state after synchronization recovers.",
          ),
        );
        // Resolve uncertainty through a fresh subscription snapshot, never by replaying the reducer.
        this.lost(generation);
        conn.disconnect();
      }, 10000);
      this.waiters.add(waiter);
      void conn.reducers
        .mutateState({
          changes: changes.map((c) => ({ ...c, value: c.value ?? undefined })),
        })
        .then(() => {
          acknowledged = true;
          // The reducer acknowledgement may precede confirmed subscription data. Do not publish optimistic state.
          void this.publishing.then(() => {
            if (waiter.check()) {
              this.waiters.delete(waiter);
              waiter.resolve();
            }
          });
        })
        .catch((error: unknown) => {
          this.waiters.delete(waiter);
          waiter.reject(
            error instanceof Error && error.message.includes("STATE_CONFLICT")
              ? new StateError(
                  "STATE_CONFLICT",
                  "Configuration changed elsewhere. Review the latest state before saving.",
                )
              : new StateError(
                  generation === this.generation && this.subscribed
                    ? "INVALID_STATE"
                    : "WRITE_UNCONFIRMED",
                  "State change could not be confirmed.",
                ),
          );
        });
    });
    await confirmed;
  }
  async close(): Promise<void> {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.timer);
    this.initialResolve?.();
    this.initialResolve = undefined;
    for (const waiter of this.waiters)
      waiter.reject(
        new StateError("WRITE_UNCONFIRMED", "Service is shutting down."),
      );
    this.waiters.clear();
    this.connection?.disconnect();
    await this.publishing;
  }
}
