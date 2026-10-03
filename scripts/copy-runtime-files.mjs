import { mkdir, cp } from "node:fs/promises";
import { writeBuildInfo } from "./build-info.mjs";

await mkdir("dist/config", { recursive: true });
await mkdir("dist/assets", { recursive: true });

await cp("src/config", "dist/config", {
  recursive: true,
  filter: (src) => src.endsWith(".json") || !src.includes("."),
});

await cp("src/assets", "dist/assets", {
  recursive: true,
});

await writeBuildInfo();
console.log("Runtime files and build metadata copied to dist.");
