import {
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { isRecord } from "../core/state.js";
import type { CommandRegistry } from "../core/commandRegistry.js";

interface CommandRecord {
  id: string;
  name: string;
  type?: number;
  description: string;
  options?: unknown;
  default_member_permissions?: string | null;
  nsfw?: boolean;
}
export interface CommandRest {
  get(route: string): Promise<unknown>;
  post(route: string, options: { body: unknown }): Promise<unknown>;
  patch(route: string, options: { body: unknown }): Promise<unknown>;
  delete(route: string): Promise<unknown>;
}
function records(value: unknown): CommandRecord[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.name !== "string",
    )
  )
    throw new Error("Invalid Discord command response.");
  return value as CommandRecord[];
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, field]) =>
          field !== undefined &&
          field !== null &&
          ![
            "id",
            "application_id",
            "guild_id",
            "version",
            "name_localized",
            "description_localized",
          ].includes(key) &&
          !(key === "required" && field === false) &&
          !(key === "autocomplete" && field === false) &&
          !(Array.isArray(field) && field.length === 0),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => [key, canonical(field)]),
  );
}
function comparable(
  command: RESTPostAPIChatInputApplicationCommandsJSONBody | CommandRecord,
) {
  return canonical({
    type: "type" in command ? (command.type ?? 1) : 1,
    name: command.name,
    description: command.description,
    options: command.options,
    default_member_permissions: command.default_member_permissions ?? null,
    nsfw: command.nsfw ?? false,
  });
}
export class CommandReconciler {
  private lanes = new Map<string, { work: Promise<void>; dirty: boolean }>();
  private stopping = false;
  constructor(
    private readonly applicationId: string,
    private readonly registry: CommandRegistry,
    private readonly rest: CommandRest,
  ) {}
  static discord(
    token: string,
    applicationId: string,
    registry: CommandRegistry,
  ): CommandReconciler {
    return new CommandReconciler(
      applicationId,
      registry,
      new REST({ version: "10" }).setToken(token),
    );
  }
  async cleanGlobalRegistrations(): Promise<void> {
    const route = Routes.applicationCommands(this.applicationId);
    for (const command of records(await this.rest.get(route)))
      if ((command.type ?? 1) === 1)
        await this.rest.delete(
          Routes.applicationCommand(this.applicationId, command.id),
        );
  }
  reconcile(guildId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const previous = this.lanes.get(guildId);
    if (previous) {
      previous.dirty = true;
      return previous.work;
    }
    const lane = { work: Promise.resolve(), dirty: false };
    lane.work = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      do {
        lane.dirty = false;
        await this.apply(guildId);
      } while (lane.dirty && !this.stopping);
    })();
    this.lanes.set(guildId, lane);
    void lane.work.then(
      () => {
        if (this.lanes.get(guildId) === lane) this.lanes.delete(guildId);
      },
      () => {
        if (this.lanes.get(guildId) === lane) this.lanes.delete(guildId);
      },
    );
    return lane.work;
  }
  private async apply(guildId: string): Promise<void> {
    if (this.stopping) return;
    const route = Routes.applicationGuildCommands(this.applicationId, guildId);
    const desired = this.registry.desired(guildId),
      actual = records(await this.rest.get(route));
    const names = new Set(desired.map((command) => command.name));
    const seen = new Set<string>();
    for (const command of actual)
      if ((command.type ?? 1) === 1) {
        if (!names.has(command.name) || seen.has(command.name))
          await this.rest.delete(
            Routes.applicationGuildCommand(
              this.applicationId,
              guildId,
              command.id,
            ),
          );
        else seen.add(command.name);
      }
    for (const command of desired) {
      if (this.stopping) return;
      const existing = actual.find(
        (item) => (item.type ?? 1) === 1 && item.name === command.name,
      );
      if (!existing) await this.rest.post(route, { body: command });
      else if (
        JSON.stringify(comparable(existing)) !==
        JSON.stringify(comparable(command))
      )
        await this.rest.patch(
          Routes.applicationGuildCommand(
            this.applicationId,
            guildId,
            existing.id,
          ),
          { body: command },
        );
    }
  }
  async close(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.lanes.values()].map((lane) => lane.work));
  }
}
