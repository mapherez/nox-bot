import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { loadControlApiConfig } from "../dist/controlApi.js";
import { resolveRuntimeVersion } from "../dist/utils/runtimeVersion.js";
import Logger from "../dist/utils/logger.js";
import { writeBuildInfo } from "../scripts/build-info.mjs";
import { resolveBuildVersion } from "../scripts/resolve-build-version.mjs";
import { env, key } from "./helpers.mjs";

test("API is opt-in; enabled configuration validates independent credentials and bind", () => {
  assert.deepEqual(loadControlApiConfig({}), { enabled: false, host: "127.0.0.1", port: 3100 });
  assert.equal(loadControlApiConfig({ NOX_BOT_API_KEY: key }).enabled, false);
  const valid = { ...env, NOX_BOT_API_ENABLED: "true", NOX_BOT_API_KEY: key };
  assert.deepEqual(loadControlApiConfig(valid), { enabled: true, host: "127.0.0.1", port: 3100, key });
  for (const overrides of [{ NOX_BOT_API_ENABLED: "yes" }, { NOX_BOT_API_KEY: "" }, { NOX_BOT_API_KEY: "with space" },
    { NOX_BOT_API_PORT: "0" }, { NOX_BOT_API_PORT: "65536" }, { NOX_BOT_API_PORT: "3100x" }, { NOX_BOT_API_HOST: "" }, { NOX_BOT_API_HOST: "invalid host" },
    { NOX_BOT_API_KEY: env.DISCORD_TOKEN }, { DISCORD_TOKEN: `Bot ${key}`, NOX_BOT_API_KEY: key }, { DISCORD_TOKEN: `Bearer ${key}`, NOX_BOT_API_KEY: key }]) {
    assert.throws(() => loadControlApiConfig({ ...valid, ...overrides }));
  }
  assert.equal(loadControlApiConfig({ ...valid, NOX_BOT_API_HOST: "::1" }).host, "::1");
});

test("runtime version precedence and build metadata overwrite prevent stale versions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nox-version-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const url = pathToFileURL(join(directory, "build-info.json"));
  assert.equal(await resolveRuntimeVersion({}, url), "dev");
  await writeBuildInfo(directory, { NOX_BOT_BUILD_VERSION: " v1.2.3 " });
  assert.equal(await resolveRuntimeVersion({}, url), "v1.2.3");
  assert.equal(await resolveRuntimeVersion({ NOX_BOT_VERSION: " runtime " }, url), "runtime");
  assert.equal(await resolveRuntimeVersion({ NOX_BOT_VERSION: "  " }, url), "v1.2.3");
  await writeBuildInfo(directory, {});
  assert.equal(await resolveRuntimeVersion({}, url), "dev");
  assert.deepEqual(JSON.parse(await readFile(url, "utf8")), { version: "dev" });
  for (const invalid of ["broken", "null", '{"version":42}']) {
    await writeFile(url, invalid);
    assert.equal(await resolveRuntimeVersion({}, url), "dev");
  }
});

test("published build version uses an exact Git tag or the full commit SHA", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nox-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
  assert.equal(resolveBuildVersion(directory), `git-${git("rev-parse", "HEAD")}`);
  git("tag", "v1.2.3");
  assert.equal(resolveBuildVersion(directory), "v1.2.3");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "next");
  assert.equal(resolveBuildVersion(directory), `git-${git("rev-parse", "HEAD")}`);
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "tag", "-a", "v1.9.0", "-m", "release");
  assert.equal(resolveBuildVersion(directory), "v1.9.0");
});

test("logger redacts configured secrets and never dumps upstream objects or promises", () => {
  const saved = { DISCORD_TOKEN: process.env.DISCORD_TOKEN, NOX_BOT_API_KEY: process.env.NOX_BOT_API_KEY };
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const captured = [];
  try {
    process.env.DISCORD_TOKEN = `Bot ${env.DISCORD_TOKEN}`;
    process.env.NOX_BOT_API_KEY = key;
    for (const method of Object.keys(original)) console[method] = (...args) => captured.push(args.join(" "));
    Logger.error(`Failed ${key}`, Object.assign(new Error(env.DISCORD_TOKEN), { requestBody: { content: "private message", headers: { authorization: key } } }));
    Logger.warn("Upstream", { authorization: key, content: "private message" }, Promise.resolve("private message"));
    Logger.error("REST failure", Object.assign(new Error("PRIVATE_UPSTREAM_DESCRIPTION"), { requestBody: "private message" }));
    Logger.info(env.DISCORD_TOKEN);
    Logger.success(key);
    const output = captured.join("\n");
    assert.ok(output.includes("[REDACTED]"));
    for (const secret of [env.DISCORD_TOKEN, key, "private message", "PRIVATE_UPSTREAM_DESCRIPTION"]) assert.equal(output.includes(secret), false);
  } finally {
    Object.assign(console, original);
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
