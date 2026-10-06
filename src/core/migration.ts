import { validateId } from "../controlApi.js";
import {
  validateEntity,
  isRecord,
  type StateStore,
  type StateChange,
} from "./state.js";
import type { SecretVault } from "./secrets.js";
import { builtInPlugins } from "../plugins/catalog.js";
const SOURCE = "legacy-prefix-weather";
export function legacyPlan(
  guildId: string,
  commands: unknown,
  weatherKey?: string,
) {
  validateId(guildId);
  if (!isRecord(commands))
    throw new Error("Legacy Quick Commands must be a JSON object.");
  const quick = Object.entries(commands).map(([trigger, response]) => {
    const value = {
      guildId,
      trigger: trigger.toLowerCase(),
      response,
      enabled: true,
    };
    validateEntity("quick", value);
    return value;
  });
  if (
    new Set(quick.map((command) => command.trigger)).size !== quick.length ||
    quick.length > 990
  )
    throw new Error(
      "Legacy Quick Commands contain duplicate triggers or exceed the import limit.",
    );
  if (weatherKey)
    builtInPlugins
      .find((plugin) => plugin.id === "weather")!
      .validateSecrets({ apiKey: weatherKey });
  return {
    guildId,
    quick,
    weatherKey,
    summary: {
      guildId,
      quickCommands: quick.length,
      plugins: ["dictionary", "userinfo", "ping"],
      weather: weatherKey ? "enabled" : "pending API key",
    },
  };
}
export async function importLegacy(
  state: StateStore,
  vault: SecretVault,
  plan: ReturnType<typeof legacyPlan>,
): Promise<"imported" | "already-imported"> {
  if (state.get("migration", plan.guildId, SOURCE)) return "already-imported";
  const changes: StateChange[] = [];
  for (const command of plan.quick) {
    if (state.get("quick", plan.guildId, command.trigger))
      throw new Error("Import would overwrite an existing Quick Command.");
    changes.push(
      state.change("quick", plan.guildId, command.trigger, command, "0"),
    );
  }
  for (const plugin of builtInPlugins) {
    if (state.get("plugin", plan.guildId, plugin.id))
      throw new Error("Import would overwrite existing plugin configuration.");
    changes.push(
      state.change(
        "plugin",
        plan.guildId,
        plugin.id,
        {
          guildId: plan.guildId,
          pluginId: plugin.id,
          enabled: plugin.id !== "weather" || !!plan.weatherKey,
          settings: plugin.defaults,
          secrets:
            plugin.id === "weather" && plan.weatherKey
              ? {
                  apiKey: vault.encrypt(
                    plan.weatherKey,
                    plan.guildId,
                    plugin.id,
                    "apiKey",
                  ),
                }
              : {},
        },
        "0",
      ),
    );
  }
  changes.push(
    state.change(
      "migration",
      plan.guildId,
      SOURCE,
      { guildId: plan.guildId, source: SOURCE, importedAt: Date.now() },
      "0",
    ),
  );
  await state.commit(changes);
  return "imported";
}
