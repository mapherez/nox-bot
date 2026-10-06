// Browser-safe contracts. This module imports no runtime or deployment configuration.
export type Settings = Record<
  string,
  null | boolean | number | string | unknown[] | Record<string, unknown>
>;
export interface PluginCard {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  dashboardEntry: string;
  configurable: boolean;
  commands: { name: string; usage: string; description: string }[];
  configuration: {
    revision: string;
    enabled: boolean;
    settings: Settings;
    secrets: Record<string, { configured: boolean }>;
    runtime: string;
    error?: string;
  };
}
export interface QuickCommandDTO {
  revision: string;
  trigger: string;
  response: string;
  enabled: boolean;
}
export interface GuildSnapshot {
  guildId: string;
  revision: string;
  synchronization: string;
  initialized: boolean;
  writable: boolean;
  plugins: PluginCard[];
  quickCommands: QuickCommandDTO[];
  commandSynchronization: { state: string; error?: string };
}
export interface SessionDTO {
  user: { id: string; username: string; avatar: string | null };
  csrf: string;
  expiresAt: number;
}
export interface GuildDTO {
  id: string;
  name: string;
}
export interface ChannelDTO {
  id: string;
  name: string;
  type: string;
}
export interface ApiFailure {
  code: string;
  message: string;
}
