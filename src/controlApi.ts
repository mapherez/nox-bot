import { isIP } from "node:net";

export type ProcessState = "starting" | "running" | "stopping";
export type DiscordState = "connecting" | "connected" | "reconnecting" | "disconnected";
export interface DiscordStatus {
  discord: { state: DiscordState; ready: boolean; pingMs: number | null };
  bot: { id: string; username: string } | null;
  guildCount: number;
}
export interface GuildSummary { id: string; name: string }
export interface ChannelSummary { id: string; name: string; type: "text" | "announcement" }
export interface CreatedMessage { messageId: string; channelId: string; guildId: string }
export interface DiscordOperationsContract {
  getStatus(): DiscordStatus;
  listGuilds(): Promise<GuildSummary[]>;
  listChannels(guildId: string): Promise<ChannelSummary[]>;
  sendMessage(channelId: string, content: string): Promise<CreatedMessage>;
}
export interface ServiceInfo {
  service: "nox-bot";
  version: string;
  apiVersion: "v1";
  capabilities: readonly string[];
}

export const errorStatuses = {
  AUTH_REQUIRED: 401, AUTH_INVALID: 401, INVALID_PAYLOAD: 400, INVALID_CHANNEL: 400,
  GUILD_NOT_FOUND: 404, CHANNEL_NOT_FOUND: 404, ROUTE_NOT_FOUND: 404,
  INSUFFICIENT_PERMISSIONS: 403, DISCORD_UNAVAILABLE: 503, SERVICE_UNAVAILABLE: 503,
  MESSAGE_REJECTED: 422, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
  METHOD_NOT_ALLOWED: 405, INTERNAL_ERROR: 500,
} as const;
export type ErrorCode = keyof typeof errorStatuses;
export class ControlError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "ControlError";
  }
}

export interface ControlApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  key?: string;
}

export function normalizedDiscordToken(token: string): string {
  // Same normalization as discord.js Client.login().
  return token.replace(/^(Bot|Bearer)\s*/i, "");
}

export function loadControlApiConfig(env: NodeJS.ProcessEnv): ControlApiConfig {
  const enabled = env.NOX_BOT_API_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") {
    throw new Error("NOX_BOT_API_ENABLED must be true or false.");
  }
  if (enabled === "false") return { enabled: false, host: "127.0.0.1", port: 3100 };
  const host = env.NOX_BOT_API_HOST ?? "127.0.0.1";
  if (!isIP(host) && host !== "localhost") {
    throw new Error("NOX_BOT_API_HOST must be an IP address or localhost.");
  }
  const portText = env.NOX_BOT_API_PORT ?? "3100";
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("NOX_BOT_API_PORT must be between 1 and 65535.");
  }
  const key = env.NOX_BOT_API_KEY;
  if (!key || /\s/.test(key)) throw new Error("NOX_BOT_API_KEY is required and must not contain whitespace.");
  if (env.DISCORD_TOKEN && normalizedDiscordToken(key) === normalizedDiscordToken(env.DISCORD_TOKEN)) {
    throw new Error("NOX_BOT_API_KEY must differ from DISCORD_TOKEN.");
  }
  return { enabled: true, host, port, key };
}

export function validateId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[1-9]\d{0,19}$/.test(id) || BigInt(id) > 18446744073709551615n) {
    throw new ControlError("INVALID_PAYLOAD", "IDs must be positive decimal strings within the 64-bit snowflake range.");
  }
}

export function validateContent(content: unknown): asserts content is string {
  if (typeof content !== "string" || content.trim().length === 0 || content.length > 2000) {
    throw new ControlError("INVALID_PAYLOAD", "Content must contain text and be at most 2000 UTF-16 code units.");
  }
}

export function validateMessage(payload: unknown): { channelId: string; content: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ControlError("INVALID_PAYLOAD", "Expected a JSON object with channelId and content.");
  }
  const data = payload as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || !Object.prototype.hasOwnProperty.call(data, "channelId") || !Object.prototype.hasOwnProperty.call(data, "content")) {
    throw new ControlError("INVALID_PAYLOAD", "Only channelId and content are accepted.");
  }
  validateId(data.channelId);
  validateContent(data.content);
  return { channelId: data.channelId, content: data.content };
}
