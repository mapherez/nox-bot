import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getSpacetimeImage } from "./spacetime-image.mjs";

// Explicit local images only. Never load deployment .env, start the real bot or publish images.
const architecture = process.argv[2];
if (!["amd64", "arm64"].includes(architecture))
  throw new Error("Specify amd64 or arm64.");
const project = `nox-bot-compose-test-${randomBytes(4).toString("hex")}`;
await mkdir(".tmp", { recursive: true });
const directory = await mkdtemp(resolve(".tmp/compose-run-"));
const env = join(directory, "fixture.env");
await writeFile(env, "# Isolated verification; no real credentials.\n");
const file = join(directory, "compose.yml");
const original = await readFile("docker-compose.yml", "utf8");
const image = `nox-bot:validation-${architecture}`;
await writeFile(
  file,
  original
    .replaceAll(
      "image: ghcr.io/mapherez/nox-bot:${NOX_BOT_IMAGE_TAG:-latest}",
      `image: ${image}`,
    )
    .replaceAll("    image:", `    platform: linux/${architecture}\n    image:`)
    .replace("env_file: [.env]", `env_file: ["${env.replaceAll("\\", "/")}"]`),
);
const override = join(directory, "smoke.yml");
await writeFile(
  override,
  JSON.stringify({
    services: {
      ...(process.env.NOX_BOT_SPACETIMEDB_IMAGE === undefined
        ? {}
        : { spacetimedb: { image: getSpacetimeImage() } }),
      "nox-bot": {
        entrypoint: ["node", "/app/tests/fixtures/compose-state-smoke.mjs"],
        volumes: [
          {
            type: "bind",
            source: resolve("tests"),
            target: "/app/tests",
            read_only: true,
          },
        ],
      },
    },
  }),
);
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const compose = (...args) => {
  try {
    const output = docker(
      "compose",
      "--project-directory",
      process.cwd(),
      "--env-file",
      env,
      "-p",
      project,
      "-f",
      file,
      "-f",
      override,
      ...args,
    );
    if (output.trim()) console.log(output.trim());
    return output;
  } catch (error) {
    console.error(error.stdout?.toString(), error.stderr?.toString());
    throw new Error(`Compose verification failed: ${args[0]}`);
  }
};
try {
  compose("up", "-d", "--no-build", "spacetimedb");
  compose("run", "--rm", "--no-deps", "state-init");
  compose("run", "--rm", "--no-deps", "nox-bot", "write");
  // Recreate the server: both database contents and signing keys must survive on named volumes.
  compose("up", "-d", "--no-build", "--force-recreate", "spacetimedb");
  compose("run", "--rm", "--no-deps", "state-init");
  compose("run", "--rm", "--no-deps", "nox-bot", "read");
  console.log(
    `Compose bootstrap and persistence passed on linux/${architecture}.`,
  );
} finally {
  compose("down", "--volumes", "--remove-orphans");
}
