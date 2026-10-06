import { randomBytes } from "node:crypto";
import { StateStore, StateError } from "../../dist/core/state.js";
import { SecretVault } from "../../dist/core/secrets.js";
import { PluginManager } from "../../dist/plugins/manager.js";
import { builtInPlugins } from "../../dist/plugins/catalog.js";
export async function memoryState(t, launch) {
  let callbacks,
    sequence = 0n,
    generation = 1;
  const rows = new Map();
  const transport = {
    connect: async (cb) => {
      callbacks = cb;
      await cb.snapshot([], 0n, generation);
    },
    mutate: async (changes) => {
      for (const change of changes)
        if ((rows.get(change.key)?.revision ?? 0n) !== change.expectedRevision)
          throw new StateError(
            "STATE_CONFLICT",
            "Configuration changed elsewhere.",
          );
      sequence++;
      for (const change of changes)
        change.value === null
          ? rows.delete(change.key)
          : rows.set(change.key, { ...change, revision: sequence });
      await callbacks.snapshot([...rows.values()], sequence, generation);
    },
    close: async () => {},
  };
  const state = new StateStore(transport),
    plugins = new PluginManager(
      state,
      new SecretVault(randomBytes(32).toString("base64")),
      builtInPlugins,
      () => new Set(["1", "2"]),
      launch,
    );
  t.after(async () => {
    await plugins.close();
    await state.close();
  });
  await state.start();
  return {
    state,
    plugins,
    transport,
    disconnect: () => callbacks.disconnected(),
    recover: () => {
      generation++;
      return callbacks.snapshot([...rows.values()], sequence, generation);
    },
  };
}
