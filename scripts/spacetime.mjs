import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSpacetimeImage } from "./spacetime-image.mjs";

export const SPACETIME_IMAGE = getSpacetimeImage();
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const command = process.argv[2];
if (!["build", "generate"].includes(command))
  throw new Error("Expected build or generate.");
const args =
  command === "build"
    ? ["build", "--module-path", "spacetimedb"]
    : [
        "generate",
        "--module-path",
        "spacetimedb",
        "--out-dir",
        "src/storage/bindings",
        "--lang",
        "typescript",
      ];
// Linux bind mounts retain host ownership (GitHub runners do not use UID 1000).
// Keep generated files writable by the caller and CLI configuration outside the checkout.
const identityArgs =
  typeof process.getuid === "function" && typeof process.getgid === "function"
    ? [
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--env",
        "XDG_CONFIG_HOME=/tmp/nox-spacetime/config",
        "--env",
        "XDG_DATA_HOME=/tmp/nox-spacetime/data",
      ]
    : [];
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    ...identityArgs,
    "-v",
    `${root.replaceAll("\\", "/")}:/workspace`,
    "-w",
    "/workspace",
    SPACETIME_IMAGE,
    ...args,
  ],
  { stdio: "inherit" },
);
if (result.error || result.status !== 0) process.exit(result.status || 1);
if (command === "generate") {
  // Official codegen emits bundler-style imports; Node ESM needs explicit extensions.
  async function normalize(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isDirectory()) await normalize(file);
      else if (item.name.endsWith(".ts")) {
        const source = await readFile(file, "utf8");
        await writeFile(
          file,
          source.replace(
            /(from\s+["'])(\.[^"']+)(["'])/g,
            (_, prefix, path, quote) =>
              `${prefix}${path.endsWith(".js") ? path : path + ".js"}${quote}`,
          ),
        );
      }
    }
  }
  await normalize(join(root, "src/storage/bindings"));
}
