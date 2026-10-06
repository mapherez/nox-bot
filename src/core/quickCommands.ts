import { validateId } from "../controlApi.js";
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
