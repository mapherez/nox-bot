import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { getSpacetimeImage } from "./spacetime-image.mjs";
const image = getSpacetimeImage();
const name = `nox-bot-test-${randomBytes(4).toString("hex")}`;
await mkdir(".tmp", { recursive: true });
const directory = await mkdtemp(resolve(".tmp/state-run-"));
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
try {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  docker(
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:3000`,
    image,
    "start",
  );
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if (
        (await fetch(`${url}/v1/ping`, { signal: AbortSignal.timeout(1000) }))
          .ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) {
    const status = docker("inspect", "--format", "{{.State.Status}} (exit {{.State.ExitCode}})", name);
    throw new Error(`Test SpacetimeDB did not start: ${status}. Inspect allocator/page-size compatibility.`);
  }
  console.log(`SpacetimeDB test kernel page size: ${docker("exec", name, "getconf", "PAGESIZE")} bytes.`);
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "tests/spacetime.integration.test.mjs",
      "tests/availability.integration.test.mjs",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NOX_BOT_TEST_STATE_URL: url,
        NOX_BOT_TEST_STATE_DATABASE: "nox-bot-integration",
        NOX_BOT_TEST_STATE_CREDENTIAL_FILE: join(directory, "credentials.json"),
        NOX_BOT_TEST_STATE_CONTAINER: name,
      },
    },
  );
  process.exitCode = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolveExit(code ?? 1));
  });
  try {
    console.log(`SpacetimeDB smoke memory (not a performance comparison): ${docker("stats", "--no-stream", "--format", "{{.MemUsage}}", name)}`);
  } catch {
    console.warn("SpacetimeDB smoke memory was unavailable after the test.");
  }
} finally {
  try {
    docker("rm", "-f", name);
  } catch {}
}
