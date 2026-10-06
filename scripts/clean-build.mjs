import { rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
const root = resolve("."),
  output = resolve(root, "dist");
if (dirname(output) !== root)
  throw new Error("Build output must be within the project.");
await rm(output, { recursive: true, force: true });
