import type { APIApplicationCommandOption, APIEmbed } from "discord.js";
import type { Settings } from "../core/state.js";

export type Capability =
  "http" | "attachments" | "discord-users" | "interactive";
export interface PluginCommand {
  name: string;
  description: string;
  options?: APIApplicationCommandOption[];
  handler: string;
  usage: string;
}
export interface PluginDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  runtimeEntry: string;
  dashboardEntry: string;
  capabilities: readonly Capability[];
  commands: readonly PluginCommand[];
  componentHandlers?: readonly string[];
  defaults: Settings;
  secretFields: readonly string[];
  validateSettings(value: unknown): Settings;
  validateSecrets(value: Readonly<Record<string, string>>): void;
}
export interface RichButton {
  kind: "button";
  label: string;
  action: string;
  style?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}
export interface RichSelect {
  kind: "select";
  action: string;
  placeholder?: string;
  options: Array<{ label: string; value: string; description?: string }>;
}
export interface RichContent {
  content?: string;
  embeds?: APIEmbed[];
  components?: Array<RichButton | RichSelect>;
  attachments?: Array<{ name: string; data: Uint8Array }>;
}
export interface UserSnapshot {
  id: string;
  username: string;
  avatarURL: string;
  createdTimestamp: number;
  joinedTimestamp: number | null;
  roles: string[];
}
export interface PluginContext {
  guildId: string;
  user: UserSnapshot;
  command: string;
  options: Record<string, string | number | boolean>;
  users: Record<string, UserSnapshot>;
  settings: Settings;
  secrets: Readonly<Record<string, string>>;
  latencyMs: number;
  action?: string;
  values?: string[];
}
export interface PluginRuntime {
  handlers: Record<string, (context: PluginContext) => Promise<RichContent>>;
  components?: Record<string, (context: PluginContext) => Promise<RichContent>>;
  autocomplete?: Record<
    string,
    (
      context: PluginContext,
    ) => Promise<Array<{ name: string; value: string | number }>>
  >;
  activate?(): Promise<void>;
  configure?(guilds: readonly string[]): Promise<void>;
  dispose?(): Promise<void>;
}
export type ParentMessage =
  | {
      type: "initialize";
      requestId: string;
      entry: string;
      handlers: string[];
      componentHandlers: readonly string[];
      guilds: string[];
    }
  | { type: "configure"; requestId: string; guilds: string[] }
  | {
      type: "execute" | "component" | "autocomplete";
      requestId: string;
      handler: string;
      context: PluginContext;
    }
  | { type: "dispose"; requestId: string };
export type ChildMessage =
  | {
      requestId: string;
      type: "result";
      value?: RichContent | Array<{ name: string; value: string | number }>;
    }
  | { requestId: string; type: "error"; message: string };

export function plainSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Plugin settings must be an object.");
  return value as Record<string, unknown>;
}
export function noSettings(value: unknown): Settings {
  if (Object.keys(plainSettings(value)).length)
    throw new Error("This plugin has no configurable settings.");
  return {};
}
export function noSecrets(value: Readonly<Record<string, string>>): void {
  if (Object.keys(value).length) throw new Error("This plugin has no secrets.");
}
