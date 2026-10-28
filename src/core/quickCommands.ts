import { validateId } from "../controlApi.js";
import { parseQuickCommandBackup } from "../shared/quickCommandBackup.js";
import { StateError } from "./state.js";
import type { QuickCommand, StateStore } from "./state.js";
export class QuickCommandService {
  constructor(private readonly state: StateStore) {}
  list(guildId: string, enabledOnly = false) {
    return this.state
      .list("quick", guildId)
      .filter((row) => !enabledOnly || row.data.enabled)
      .sort((a, b) => a.data.trigger.localeCompare(b.data.trigger));
  }
  response(guildId: string, trigger: string): string | undefined {
    const command = this.state.get(
      "quick",
      guildId,
      trigger.toLowerCase(),
    )?.data;
    return command?.enabled ? command.response : undefined;
  }
  export(guildId: string) {
    validateId(guildId);
    if (!this.state.initialized)
      throw new StateError(
        "STATE_UNAVAILABLE",
        "Wait for confirmed commands before exporting.",
      );
    return this.list(guildId).map(
      ({ data: { trigger, response, enabled } }) => ({
        trigger,
        response,
        enabled,
      }),
    );
  }
  async import(
    guildId: string,
    value: unknown,
    expectedRevisions: unknown,
  ): Promise<number> {
    validateId(guildId);
    if (!this.state.writable)
      throw new StateError(
        "STATE_UNAVAILABLE",
        "Wait for synchronization before importing commands.",
      );
    let commands;
    try {
      commands = parseQuickCommandBackup(value, guildId);
    } catch (cause) {
      throw new StateError("INVALID_STATE", (cause as Error).message);
    }
    if (
      !expectedRevisions ||
      typeof expectedRevisions !== "object" ||
      Array.isArray(expectedRevisions)
    )
      throw new StateError(
        "INVALID_STATE",
        "Expected command revisions are required.",
      );
    const revisions = expectedRevisions as Record<string, unknown>;
    if (Object.keys(revisions).length !== commands.length)
      throw new StateError(
        "INVALID_STATE",
        "Expected revisions must match the imported commands.",
      );
    // Validate the ENTIRE backup and its revision expectations before the first write.
    const changes = commands.map((command) => {
      const revision = Object.prototype.hasOwnProperty.call(
        revisions,
        command.trigger,
      )
        ? revisions[command.trigger]
        : undefined;
      if (typeof revision !== "string" || !/^\d+$/.test(revision))
        throw new StateError("INVALID_STATE", "Invalid command revision.");
      if (
        (this.state.get("quick", guildId, command.trigger)?.revision ?? "0") !==
        revision
      )
        throw new StateError(
          "STATE_CONFLICT",
          "Commands changed after the import preview. Choose the file again to review the latest commands.",
        );
      return this.state.change(
        "quick",
        guildId,
        command.trigger,
        { guildId, ...command },
        revision,
      );
    });
    // SQLite commits the complete validated import in one atomic transaction.
    if (changes.length) await this.state.commit(changes);
    return changes.length;
  }

  async save(
    guildId: string,
    input: QuickCommand,
    expectedRevision: string,
  ): Promise<void> {
    validateId(guildId);
    if (input.guildId !== guildId)
      throw new Error("Quick Command belongs to another server.");
    const data = { ...input, trigger: input.trigger.trim().toLowerCase() };
    await this.state.put(
      "quick",
      guildId,
      data.trigger,
      data,
      expectedRevision,
    );
  }
  async delete(
    guildId: string,
    trigger: string,
    expectedRevision: string,
  ): Promise<void> {
    validateId(guildId);
    await this.state.remove(
      "quick",
      guildId,
      trigger.toLowerCase(),
      expectedRevision,
    );
  }
}
