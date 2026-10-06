import { lazy } from "react";
// Vite discovers plugin-owned dashboard entries without importing backend runtimes.
const entries = import.meta.glob<{
  default: React.ComponentType<import("./plugins/types").PluginPanelProps>;
}>("./plugins/*.tsx");
export const panels = Object.fromEntries(
  Object.entries(entries)
    .filter(([path]) => !path.endsWith("/types.tsx"))
    .map(([path, loader]) => [
      path.split("/").pop()!.replace(".tsx", ""),
      lazy(loader),
    ]),
);
