import { EventEmitter } from "node:events";
import {
  validateStateDocument,
  validateStateValue,
} from "../shared/stateValidation.js";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Settings = Record<string, Json>;
export interface GuildConfig {
  guildId: string;
  name?: string;
}
export interface GuildPlugin {
  guildId: string;
  pluginId: string;
  enabled: boolean;
  settings: Settings;
  secrets: Record<string, string>;
}
export interface QuickCommand {
  guildId: string;
  trigger: string;
  response: string;
  enabled: boolean;
}
export interface AuthorizedUser {
  userId: string;
  role: "owner";
}
export interface Session {
  hash: string;
  userId: string;
  username: string;
  avatar: string | null;
  csrf: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}
export interface Migration {
  guildId: string;
  source: string;
  importedAt: number;
}
export interface Entities {
  guild: GuildConfig;
  plugin: GuildPlugin;
  quick: QuickCommand;
  user: AuthorizedUser;
  session: Session;
  migration: Migration;
}
export type EntityKind = keyof Entities;
export type StateRow = {
  key: string;
  kind: string;
  guildId: string;
  value: string;
  revision: bigint;
};
export interface StateChange {
  key: string;
  kind: EntityKind;
  guildId: string;
  value: string | null;
  expectedRevision: bigint;
}
export type SyncState =
  "starting" | "synced" | "reconnecting" | "recovering" | "closed";
export interface TransportCallbacks {
  snapshot(
    rows: readonly StateRow[],
    sequence: bigint,
    generation: number,
  ): Promise<void>;
  disconnected(): void;
  recovering(): void;
}
export interface StateTransport {
  connect(callbacks: TransportCallbacks): Promise<void>;
  mutate(changes: readonly StateChange[]): Promise<void>;
  close(): Promise<void>;
}
export class StateError extends Error {
  constructor(
    public readonly code:
      | "STATE_UNAVAILABLE"
      | "STATE_CONFLICT"
      | "WRITE_UNCONFIRMED"
      | "INVALID_STATE",
    message: string,
  ) {
    super(message);
  }
}
export const stateKey = (kind: EntityKind, guildId: string, id = "") =>
  `${kind}:${guildId}:${id}`;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value)
    ? value.every(isJson)
    : isRecord(value) && Object.values(value).every(isJson);
}
export function validateEntity<K extends EntityKind>(
  kind: K,
  value: unknown,
): asserts value is Entities[K] {
  try {
    validateStateValue(kind, value);
  } catch {
    throw new StateError("INVALID_STATE", `Invalid ${kind} state.`);
  }
  if (!isRecord(value))
    throw new StateError("INVALID_STATE", "State value must be an object.");
  const text = (key: string) => typeof value[key] === "string";
  const time = (key: string) =>
    typeof value[key] === "number" &&
    Number.isSafeInteger(value[key]) &&
    value[key] >= 0;
  let valid: boolean;
  switch (kind) {
    case "guild":
      valid = text("guildId");
      break;
    case "plugin":
      valid =
        text("guildId") &&
        text("pluginId") &&
        typeof value.enabled === "boolean" &&
        isRecord(value.settings) &&
        isJson(value.settings) &&
        isRecord(value.secrets) &&
        Object.values(value.secrets).every((v) => typeof v === "string");
      break;
    case "quick":
      valid =
        text("guildId") &&
        text("trigger") &&
        /^[a-z0-9_-]{1,32}$/.test(String(value.trigger)) &&
        value.trigger !== "help" &&
        text("response") &&
        String(value.response).trim().length > 0 &&
        String(value.response).length <= 2000 &&
        typeof value.enabled === "boolean";
      break;
    case "user":
      valid = text("userId") && value.role === "owner";
      break;
    case "session":
      valid =
        text("hash") &&
        text("userId") &&
        text("username") &&
        text("csrf") &&
        (value.avatar === null || text("avatar")) &&
        time("createdAt") &&
        time("expiresAt") &&
        time("lastSeenAt");
      break;
    case "migration":
      valid = text("guildId") && text("source") && time("importedAt");
      break;
  }
  if (!valid) throw new StateError("INVALID_STATE", `Invalid ${kind} state.`);
}

/** Confirmed projection: disconnection never clears rows or emits a functional reset. */
export class StateStore extends EventEmitter {
  private rows = new Map<string, StateRow>();
  private sequence = -1n;
  private generation = -1;
  private hasSnapshot = false;
  private connectionEpoch = 0;
  private sync: SyncState = "starting";
  private opening?: Promise<void>;
  private applying = Promise.resolve();
  private projections = new Set<() => Promise<void>>();
  constructor(private readonly transport: StateTransport) {
    super();
  }
  get synchronization(): SyncState {
    return this.sync;
  }
  get initialized(): boolean {
    return this.hasSnapshot;
  }
  get writable(): boolean {
    return this.sync === "synced";
  }
  get revision(): string {
    return this.sequence.toString();
  }
  private setSync(state: SyncState) {
    if (this.sync !== state) {
      this.sync = state;
      this.emit("sync", state);
    }
  }
  addProjection(project: () => Promise<void>): () => void {
    this.projections.add(project);
    return () => this.projections.delete(project);
  }
  start(): Promise<void> {
    return (this.opening ??= this.transport.connect({
      snapshot: (rows, sequence, generation) =>
        this.apply(rows, sequence, generation),
      disconnected: () => {
        ++this.connectionEpoch;
        this.setSync("reconnecting");
      },
      recovering: () => {
        ++this.connectionEpoch;
        this.setSync("recovering");
      },
    }));
  }
  private apply(
    rows: readonly StateRow[],
    sequence: bigint,
    generation: number,
  ): Promise<void> {
    const epoch = this.connectionEpoch;
    const work = this.applying.then(async () => {
      if (
        epoch !== this.connectionEpoch ||
        this.sync === "closed" ||
        generation < this.generation ||
        sequence < this.sequence
      )
        return;
      const next = new Map<string, StateRow>();
      for (const row of rows) {
        if (
          ![
            "guild",
            "plugin",
            "quick",
            "user",
            "session",
            "migration",
          ].includes(row.kind)
        )
          throw new StateError("INVALID_STATE", "Unknown state kind.");
        try {
          validateStateDocument(
            row.kind,
            row.guildId,
            row.key,
            JSON.parse(row.value),
          );
        } catch {
          throw new StateError(
            "INVALID_STATE",
            "Invalid confirmed state document.",
          );
        }
        if (next.has(row.key) || row.revision < 1n || row.revision > sequence)
          throw new StateError("INVALID_STATE", "Invalid confirmed revision.");
        const previous = this.rows.get(row.key);
        if (previous && row.revision < previous.revision)
          throw new StateError("INVALID_STATE", "State revision regressed.");
        next.set(row.key, Object.freeze({ ...row }));
      }
      this.setSync("recovering");
      this.rows = next;
      this.sequence = sequence;
      this.generation = generation;
      this.hasSnapshot = true;
      // Swap the entire snapshot before starting lifecycle work. Consumers never see half a transaction.
      for (const project of this.projections) await project();
      // A socket loss while projections run must not re-open writes.
      if (epoch === this.connectionEpoch && this.sync === "recovering")
        this.setSync("synced");
      this.emit("change");
    });
    this.applying = work.catch(() => {});
    return work;
  }
  list<K extends EntityKind>(
    kind: K,
    guildId?: string,
  ): Array<{ key: string; revision: string; data: Entities[K] }> {
    const result: Array<{ key: string; revision: string; data: Entities[K] }> =
      [];
    for (const row of this.rows.values()) {
      if (
        row.kind !== kind ||
        (guildId !== undefined && row.guildId !== guildId)
      )
        continue;
      const data: unknown = JSON.parse(row.value);
      validateEntity(kind, data);
      result.push({ key: row.key, revision: row.revision.toString(), data });
    }
    return result;
  }
  get<K extends EntityKind>(
    kind: K,
    guildId: string,
    id = "",
  ): { revision: string; data: Entities[K] } | undefined {
    const row = this.rows.get(stateKey(kind, guildId, id));
    if (!row) return;
    const data: unknown = JSON.parse(row.value);
    validateEntity(kind, data);
    return { revision: row.revision.toString(), data };
  }
  change<K extends EntityKind>(
    kind: K,
    guildId: string,
    id: string,
    data: Entities[K] | null,
    expectedRevision: string,
  ): StateChange {
    if (!/^\d+$/.test(expectedRevision))
      throw new StateError("INVALID_STATE", "Invalid revision.");
    if (data !== null) validateEntity(kind, data);
    try {
      validateStateDocument(
        kind,
        guildId,
        stateKey(kind, guildId, id),
        data ?? undefined,
      );
    } catch {
      throw new StateError("INVALID_STATE", "Invalid state namespace.");
    }
    if (BigInt(expectedRevision) > 18446744073709551615n)
      throw new StateError("INVALID_STATE", "Invalid revision.");
    return {
      key: stateKey(kind, guildId, id),
      kind,
      guildId,
      value: data === null ? null : JSON.stringify(data),
      expectedRevision: BigInt(expectedRevision),
    };
  }
  async commit(changes: readonly StateChange[]): Promise<void> {
    if (!this.writable)
      throw new StateError(
        "STATE_UNAVAILABLE",
        "Configuration changes are unavailable until state synchronization recovers.",
      );
    await this.transport.mutate(changes);
  }
  async put<K extends EntityKind>(
    kind: K,
    guildId: string,
    id: string,
    data: Entities[K],
    expectedRevision = this.get(kind, guildId, id)?.revision ?? "0",
  ): Promise<void> {
    await this.commit([this.change(kind, guildId, id, data, expectedRevision)]);
  }
  async remove(
    kind: EntityKind,
    guildId: string,
    id: string,
    expectedRevision: string,
  ): Promise<void> {
    await this.commit([this.change(kind, guildId, id, null, expectedRevision)]);
  }
  async close(): Promise<void> {
    this.setSync("closed");
    await this.transport.close();
    await this.applying;
    this.removeAllListeners();
  }
}
