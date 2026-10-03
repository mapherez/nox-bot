import { readFile } from "node:fs/promises";
import type { ServiceInfo } from "../controlApi.js";

export async function resolveRuntimeVersion(
  env: NodeJS.ProcessEnv = process.env,
  buildInfoUrl: URL = new URL("../build-info.json", import.meta.url),
): Promise<string> {
  const explicit = env.NOX_DISCORD_VERSION?.trim();
  if (explicit) return explicit;
  try {
    const info: unknown = JSON.parse(await readFile(buildInfoUrl, "utf8"));
    if (info && typeof info === "object" && "version" in info && typeof info.version === "string") {
      return info.version.trim() || "dev";
    }
  } catch {
    // Source runs and local builds need no incorporated release metadata.
  }
  return "dev";
}

export function createServiceInfo(version: string): ServiceInfo {
  return Object.freeze({
    service: "nox-discord-bot", version, apiVersion: "v1",
    capabilities: Object.freeze(["discord-status", "guilds", "channels", "messages"]),
  });
}
