import { normalizedDiscordToken } from "../controlApi.js";

function redact(value: string): string {
  const secrets = [process.env.DISCORD_TOKEN, process.env.NOX_DISCORD_API_KEY];
  if (process.env.DISCORD_TOKEN) secrets.push(normalizedDiscordToken(process.env.DISCORD_TOKEN));
  for (const secret of secrets.filter((item): item is string => !!item).sort((a, b) => b.length - a.length)) {
    value = value.split(secret).join("[REDACTED]");
  }
  return value;
}

// REST error objects may contain authorization headers and message bodies. Never inspect them.
function safeArgument(value: unknown): string {
  if (value instanceof Error) {
    if ("requestBody" in value || "config" in value || "request" in value) return redact(value.name);
    return redact(`${value.name}: ${value.message}`);
  }
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  return "[details omitted]";
}

class Logger {
  static info(message: string, ...args: unknown[]): void {
    console.log(`ℹ️  ${redact(message)}`, ...args.map(safeArgument));
  }
  static success(message: string, ...args: unknown[]): void {
    console.log(`✅ ${redact(message)}`, ...args.map(safeArgument));
  }
  static warn(message: string, ...args: unknown[]): void {
    console.warn(`⚠️  ${redact(message)}`, ...args.map(safeArgument));
  }
  static error(message: string, ...args: unknown[]): void {
    console.error(`❌ ${redact(message)}`, ...args.map(safeArgument));
  }
  static debug(message: string, ...args: unknown[]): void {
    if (process.env.NODE_ENV === "development") console.debug(`🐛 ${redact(message)}`, ...args.map(safeArgument));
  }
}
export default Logger;
