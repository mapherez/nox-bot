import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { getSpacetimeImage } from "./spacetime-image.mjs";

const architecture = process.argv[2];
assert.ok(["amd64", "arm64"].includes(architecture), "Specify amd64 or arm64.");
assert.ok(process.env.NOX_BOT_SPACETIMEDB_IMAGE, "Explicit candidate image required.");
const image = getSpacetimeImage();
const docker = (...args) => execFileSync("docker", args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const run = (entry, ...args) => docker("run", "--rm", "--platform", `linux/${architecture}`, "--entrypoint", entry, image, ...args);
assert.equal(docker("image", "inspect", "--format", "{{.Architecture}}", image), architecture);
const info = JSON.parse(run("cat", "/opt/spacetime/nox-build-info.json"));
assert.equal(info.version, "2.10.2");
assert.equal(info.upstreamCommit, "58d2a40718c59535fd5c267e836d473298eb84d5");
assert.equal(info.architecture, architecture);
assert.equal(info.jemallocLgPage, architecture === "arm64" ? "16" : "upstream");
assert.equal(run("id", "-u"), "1000");
assert.equal(run("id", "-g"), "1000");
for (const entry of ["/opt/spacetime/spacetimedb-cli", "/opt/spacetime/spacetimedb-standalone"])
  assert.match(run(entry, "--version"), /\b2\.10\.2\b/);
const configuration = JSON.parse(docker("image", "inspect", image))[0].Config;
assert.deepEqual(configuration.Entrypoint, ["spacetime"]);
console.log(`SpacetimeDB candidate verified: linux/${architecture}, kernel pages=${run("getconf", "PAGESIZE")}, allocator=${info.jemallocLgPage}.`);
console.log("Build metadata confirms build inputs; 16 KB compatibility still requires the actual host smoke.");
