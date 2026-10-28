import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { validateStateDocument } from "../shared/stateValidation.js";
import { StateError, type StateChange, type StateRow } from "../core/state.js";
import type {
  SqliteRequest,
  SqliteReply,
  SqliteSnapshot,
} from "./sqliteProtocol.js";

const APPLICATION_ID = 0x4e4f5842;
const MAX_REVISION = 18446744073709551615n;
let database: DatabaseSync | undefined;
function db(): DatabaseSync {
  if (!database)
    throw new StateError(
      "STATE_UNAVAILABLE",
      "The SQLite database is not open.",
    );
  return database;
}
function snapshot(): SqliteSnapshot {
  const connection = db();
  const revision = connection
    .prepare("SELECT revision FROM state_meta WHERE id = 1")
    .get()!;
  const rows = connection
    .prepare(
      "SELECT key, kind, guild_id AS guildId, value, revision FROM documents ORDER BY key",
    )
    .all();
  return {
    sequence: BigInt(revision.revision as string),
    rows: rows.map(
      (row) =>
        ({ ...row, revision: BigInt(row.revision as string) }) as StateRow,
    ),
  };
}
function open(filename: string, create: boolean): SqliteSnapshot {
  if (!create && !existsSync(filename))
    throw new StateError(
      "STATE_UNAVAILABLE",
      "The existing SQLite database is missing. Restore the data volume before restarting.",
    );
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const descriptor = openSync(filename, "a", 0o600);
  closeSync(descriptor);
  database = new DatabaseSync(filename, { timeout: 250 });
  try {
    const connection = db();
    const version = connection.prepare("PRAGMA user_version").get()!
      .user_version;
    const applicationId = connection.prepare("PRAGMA application_id").get()!
      .application_id;
    if (!create && version === 0)
      throw new StateError(
        "STATE_UNAVAILABLE",
        "The existing SQLite database was replaced by an empty file. Restore the data volume before restarting.",
      );
    if (version === 0 && applicationId === 0) {
      const tables = connection
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (tables.length)
        throw new StateError(
          "INVALID_STATE",
          "The selected SQLite file belongs to another application.",
        );
    } else if (version !== 1 || applicationId !== APPLICATION_ID) {
      throw new StateError(
        "INVALID_STATE",
        "Unsupported SQLite database schema. Use a compatible bot version and data volume.",
      );
    }
    connection.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;",
    );
    if (version === 0) {
      connection.exec(`BEGIN IMMEDIATE;
        CREATE TABLE documents (key TEXT PRIMARY KEY, kind TEXT NOT NULL, guild_id TEXT NOT NULL, value TEXT NOT NULL, revision TEXT NOT NULL) STRICT;
        CREATE TABLE state_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision TEXT NOT NULL) STRICT;
        INSERT INTO state_meta VALUES (1, '0');
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
        COMMIT;`);
    }
    return snapshot();
  } catch (error) {
    database.close();
    database = undefined;
    throw error;
  }
}
function mutate(changes: readonly StateChange[]): SqliteSnapshot {
  if (!Array.isArray(changes) || !changes.length)
    throw new StateError(
      "INVALID_STATE",
      "A non-empty transaction is required.",
    );
  const connection = db(),
    seen = new Set<string>();
  for (const change of changes) {
    if (
      seen.has(change.key) ||
      change.expectedRevision < 0n ||
      change.expectedRevision > MAX_REVISION
    )
      throw new StateError(
        "INVALID_STATE",
        "Invalid transaction key or revision.",
      );
    seen.add(change.key);
    try {
      if (change.value !== null && change.value.length > 65536)
        throw new Error("State value too large");
      validateStateDocument(
        change.kind,
        change.guildId,
        change.key,
        change.value === null ? undefined : JSON.parse(change.value),
      );
    } catch {
      throw new StateError("INVALID_STATE", "Invalid state document.");
    }
  }
  connection.exec("BEGIN IMMEDIATE");
  try {
    const get = connection.prepare(
      "SELECT revision FROM documents WHERE key = ?",
    );
    for (const change of changes) {
      const previous = get.get(change.key);
      if (
        BigInt((previous?.revision as string | undefined) ?? "0") !==
        change.expectedRevision
      )
        throw new StateError(
          "STATE_CONFLICT",
          "Configuration changed elsewhere. Review the latest state before saving.",
        );
    }
    const previous = connection
      .prepare("SELECT revision FROM state_meta WHERE id = 1")
      .get()!;
    const revision = BigInt(previous.revision as string) + 1n;
    if (revision > MAX_REVISION)
      throw new StateError("INVALID_STATE", "Database revision limit reached.");
    const put = connection.prepare(
      "INSERT INTO documents (key, kind, guild_id, value, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, guild_id = excluded.guild_id, value = excluded.value, revision = excluded.revision",
    );
    const remove = connection.prepare("DELETE FROM documents WHERE key = ?");
    for (const change of changes) {
      if (change.value === null) remove.run(change.key);
      else
        put.run(
          change.key,
          change.kind,
          change.guildId,
          change.value,
          revision.toString(),
        );
    }
    connection
      .prepare("UPDATE state_meta SET revision = ? WHERE id = 1")
      .run(revision.toString());
    // Construct the snapshot before COMMIT so validation/allocation failures can roll back.
    const result = snapshot();
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}
parentPort!.on("message", (request: SqliteRequest) => {
  let reply: SqliteReply;
  try {
    if (request.type === "open")
      reply = {
        id: request.id,
        snapshot: open(request.filename, request.create),
      };
    else if (request.type === "mutate")
      reply = { id: request.id, snapshot: mutate(request.changes) };
    else {
      database?.close();
      database = undefined;
      reply = { id: request.id };
    }
  } catch (error) {
    reply = {
      id: request.id,
      error:
        error instanceof StateError
          ? {
              code: error.code as
                | "STATE_CONFLICT"
                | "STATE_UNAVAILABLE"
                | "INVALID_STATE",
              message: error.message,
            }
          : {
              code: "STATE_UNAVAILABLE",
              message:
                request.type === "open"
                  ? "Could not open SQLite. Check the data directory permissions, database file and available disk space."
                  : "SQLite could not commit the transaction. Check the data volume, file locks and available disk space.",
            },
    };
  }
  parentPort!.postMessage(reply);
});
