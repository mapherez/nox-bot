import "dotenv/config";
import { readFile } from "node:fs/promises";
import { legacyPlan, importLegacy } from "../dist/core/migration.js";
import { StateStore } from "../dist/core/state.js";
import { SecretVault } from "../dist/core/secrets.js";
import {
  SpacetimeTransport,
  loadSpacetimeConfig,
} from "../dist/storage/spacetime.js";
const args = process.argv.slice(2),
  fields = {};
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (key === "--dry-run") fields.dryRun = true;
  else if (
    ["--guild", "--commands", "--weather-key-env"].includes(key) &&
    args[index + 1] &&
    !args[index + 1].startsWith("--")
  )
    fields[key.slice(2)] = args[++index];
  else
    throw new Error(
      "Usage: node scripts/import-legacy.mjs --guild ID --commands FILE [--weather-key-env NAME] [--dry-run]",
    );
}
if (!fields.guild || !fields.commands)
  throw new Error(
    "Destination --guild and legacy --commands file are required.",
  );
const weatherKey = fields["weather-key-env"]
  ? process.env[fields["weather-key-env"]]
  : undefined;
const plan = legacyPlan(
  fields.guild,
  JSON.parse(await readFile(fields.commands, "utf8")),
  weatherKey,
);
console.log(JSON.stringify(plan.summary));
if (fields.dryRun)
  console.log(
    "Dry run: no identities, Discord registrations or persisted state changed.",
  );
else {
  if (!process.env.DISCORD_TOKEN)
    throw new Error(
      "DISCORD_TOKEN is required to verify the destination server.",
    );
  const guild = await fetch(
    `https://discord.com/api/v10/guilds/${fields.guild}`,
    {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_TOKEN.replace(/^(Bot|Bearer)\s*/i, "")}`,
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!guild.ok)
    throw new Error("The destination server could not be verified in Discord.");
  const state = new StateStore(
    new SpacetimeTransport(await loadSpacetimeConfig(process.env)),
  );
  const deadline = setTimeout(() => {
    void state.close();
  }, 20000);
  try {
    await state.start();
    if (!state.writable)
      throw new Error("State synchronization did not become ready.");
    console.log(
      await importLegacy(
        state,
        new SecretVault(process.env.NOX_BOT_ENCRYPTION_KEY ?? ""),
        plan,
      ),
    );
  } finally {
    clearTimeout(deadline);
    await state.close();
  }
}
