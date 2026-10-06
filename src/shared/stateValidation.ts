// Pure validation shared by the backend and database module.
const kinds = ["guild", "plugin", "quick", "user", "session", "migration"];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const snowflake = (value: unknown) =>
  typeof value === "string" &&
  /^[1-9]\d{0,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
function json(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every((item) => json(item, depth + 1))) ||
    (record(value) &&
      Object.entries(value).every(
        ([key, item]) =>
          !["__proto__", "prototype", "constructor"].includes(key) &&
          json(item, depth + 1),
      ))
  );
}
export function validateStateValue(kind: string, value: unknown): void {
  if (!record(value)) throw new Error("Invalid state value.");
  const text = (key: string, max = 128) =>
    typeof value[key] === "string" &&
    value[key].length > 0 &&
    value[key].length <= max;
  const time = (key: string) =>
    typeof value[key] === "number" &&
    Number.isSafeInteger(value[key]) &&
    value[key] >= 0;
  const fields: Record<string, string[]> = {
    guild: ["guildId", "name"],
    plugin: ["guildId", "pluginId", "enabled", "settings", "secrets"],
    quick: ["guildId", "trigger", "response", "enabled"],
    user: ["userId", "role"],
    session: [
      "hash",
      "userId",
      "username",
      "avatar",
      "csrf",
      "createdAt",
      "expiresAt",
      "lastSeenAt",
    ],
    migration: ["guildId", "source", "importedAt"],
  };
  if (
    !kinds.includes(kind) ||
    Object.keys(value).some((key) => !fields[kind].includes(key))
  )
    throw new Error("Invalid state fields.");
  let valid = false;
  switch (kind) {
    case "guild":
      valid =
        snowflake(value.guildId) &&
        (value.name === undefined || text("name", 100));
      break;
    case "plugin":
      valid =
        snowflake(value.guildId) &&
        text("pluginId", 32) &&
        /^[a-z][a-z0-9-]*$/.test(String(value.pluginId)) &&
        typeof value.enabled === "boolean" &&
        record(value.settings) &&
        json(value.settings) &&
        record(value.secrets) &&
        Object.entries(value.secrets).every(
          ([field, secret]) =>
            /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field) &&
            !["constructor", "prototype"].includes(field) &&
            typeof secret === "string" &&
            secret.length < 8192 &&
            /^aes256gcm\./.test(secret),
        );
      break;
    case "quick":
      valid =
        snowflake(value.guildId) &&
        text("trigger", 32) &&
        /^[a-z0-9_-]+$/.test(String(value.trigger)) &&
        value.trigger !== "help" &&
        text("response", 2000) &&
        !!String(value.response).trim() &&
        typeof value.enabled === "boolean";
      break;
    case "user":
      valid = snowflake(value.userId) && value.role === "owner";
      break;
    case "session":
      valid =
        text("hash", 64) &&
        /^[a-f0-9]{64}$/.test(String(value.hash)) &&
        snowflake(value.userId) &&
        text("username") &&
        text("csrf", 128) &&
        (value.avatar === null || text("avatar")) &&
        time("createdAt") &&
        time("expiresAt") &&
        time("lastSeenAt") &&
        Number(value.createdAt) <= Number(value.lastSeenAt) &&
        Number(value.lastSeenAt) < Number(value.expiresAt);
      break;
    case "migration":
      valid =
        snowflake(value.guildId) &&
        text("source", 100) &&
        /^[a-zA-Z0-9_-]+$/.test(String(value.source)) &&
        time("importedAt");
      break;
  }
  if (!valid) throw new Error(`Invalid ${kind} state.`);
}
export function validateStateDocument(
  kind: string,
  guildId: string,
  key: string,
  value?: unknown,
): void {
  if (
    !kinds.includes(kind) ||
    key.length > 256 ||
    !key.startsWith(`${kind}:${guildId}:`)
  )
    throw new Error("Invalid state key.");
  const id = key.slice(kind.length + guildId.length + 2);
  if (["user", "session"].includes(kind) ? guildId !== "" : !snowflake(guildId))
    throw new Error("Invalid state namespace.");
  if (
    (kind === "guild" && id !== "") ||
    (kind === "user" && !snowflake(id)) ||
    (kind === "session" && !/^[a-f0-9]{64}$/.test(id)) ||
    (kind === "plugin" && !/^[a-z][a-z0-9-]{0,31}$/.test(id)) ||
    (kind === "quick" && (!/^[a-z0-9_-]{1,32}$/.test(id) || id === "help")) ||
    (kind === "migration" && !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
  )
    throw new Error("Invalid state identifier.");
  if (value !== undefined) {
    validateStateValue(kind, value);
    const data = value as Record<string, unknown>;
    if (
      ["user", "session"].includes(kind)
        ? (kind === "user" ? data.userId : data.hash) !== id
        : data.guildId !== guildId
    )
      throw new Error("State value belongs to another namespace.");
    if (
      (kind === "plugin" && data.pluginId !== id) ||
      (kind === "quick" && data.trigger !== id) ||
      (kind === "migration" && data.source !== id)
    )
      throw new Error("State identifier does not match its value.");
  }
}
