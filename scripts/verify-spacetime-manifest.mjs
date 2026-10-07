import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

export function verifyManifest(manifest, expected = {}) {
  assert.ok(Array.isArray(manifest.manifests), "Expected a multiarchitecture index.");
  const images = manifest.manifests.filter(item => item.platform?.os === "linux");
  assert.equal(images.length, 2, "Expected exactly two Linux images.");
  assert.deepEqual(images.map(item => item.platform.architecture).sort(), ["amd64", "arm64"]);
  for (const item of images) {
    assert.match(item.digest, /^sha256:[a-f0-9]{64}$/);
    const architecture = item.platform.architecture;
    if (expected[architecture]) assert.equal(item.digest, expected[architecture], `Unexpected ${architecture} digest.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const reference = process.argv[2];
  assert.ok(reference, "Specify the published image reference.");
  const expected = {};
  if (process.argv[3]) {
    for (const architecture of ["amd64", "arm64"]) {
      const artifact = JSON.parse(readFileSync(join(process.argv[3], `${architecture}.json`), "utf8"));
      assert.equal(artifact.architecture, architecture);
      assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
      expected[architecture] = artifact.digest;
    }
  }
  const manifest = JSON.parse(execFileSync("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], { encoding: "utf8" }));
  verifyManifest(manifest, expected);
  console.log(`Published manifest verified: linux/amd64 and linux/arm64${Object.keys(expected).length ? " with the expected digests" : " (architecture check only)"}.`);
}
