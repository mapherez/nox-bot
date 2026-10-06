import { access } from "node:fs/promises";
import { builtInPlugins } from "../dist/plugins/catalog.js";
import { PluginManager } from "../dist/plugins/manager.js";
import { StateStore } from "../dist/core/state.js";
import { SecretVault } from "../dist/core/secrets.js";
const state = new StateStore({
  connect: async () => {},
  mutate: async () => {},
  close: async () => {},
});
const manager = new PluginManager(
  state,
  new SecretVault(Buffer.alloc(32).toString("base64")),
  builtInPlugins,
  () => new Set(),
);
try {
  for (const plugin of builtInPlugins) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(plugin.dashboardEntry))
      throw new Error("Invalid dashboard entry.");
    await access(
      new URL(
        `../dist/plugins/${plugin.runtimeEntry.slice(2)}`,
        import.meta.url,
      ),
    );
    await access(
      new URL(
        `../web/src/plugins/${plugin.dashboardEntry}.tsx`,
        import.meta.url,
      ),
    );
  }
} finally {
  await manager.close();
  await state.close();
}
console.log(
  "Built-in catalog contracts and runtime/dashboard entries verified.",
);
