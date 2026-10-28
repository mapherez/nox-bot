import { validateStateValue } from "./stateValidation.js";

export interface QuickCommandBackupEntry {
  trigger: string;
  response: string;
  enabled: boolean;
}
export const QUICK_COMMAND_BACKUP_MAX_BYTES = 16 * 1024 * 1024;

// Portable JSON contains command content only, never database revisions or server IDs.
export function parseQuickCommandBackup(
  value: unknown,
  guildId: string,
): QuickCommandBackupEntry[] {
  if (!Array.isArray(value))
    throw new Error("Choose a JSON array of Quick Commands.");
  const seen = new Set<string>();
  return value.map((entry: unknown, index) => {
    const invalid = () =>
      new Error(
        `Command ${index + 1} must contain a valid trigger, response and enabled flag.`,
      );
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw invalid();
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) => !["trigger", "response", "enabled"].includes(key),
      ) ||
      typeof row.trigger !== "string" ||
      typeof row.response !== "string" ||
      typeof row.enabled !== "boolean"
    )
      throw invalid();
    const command = {
      trigger: row.trigger.trim().toLowerCase(),
      response: row.response,
      enabled: row.enabled,
    };
    try {
      validateStateValue("quick", { guildId, ...command });
    } catch {
      throw invalid();
    }
    if (seen.has(command.trigger))
      throw new Error(
        `Command ${index + 1} duplicates the trigger !${command.trigger}.`,
      );
    seen.add(command.trigger);
    return command;
  });
}
