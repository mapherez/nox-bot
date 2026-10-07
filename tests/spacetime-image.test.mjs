import test from "node:test";
import assert from "node:assert/strict";
import { getSpacetimeImage, DEFAULT_SPACETIME_IMAGE } from "../scripts/spacetime-image.mjs";
import { verifyManifest } from "../scripts/verify-spacetime-manifest.mjs";

test("candidate image selection never silently falls back for an invalid explicit override", () => {
  assert.equal(getSpacetimeImage({}), DEFAULT_SPACETIME_IMAGE);
  assert.equal(getSpacetimeImage({ NOX_BOT_SPACETIMEDB_IMAGE: "nox-spacetimedb:candidate-arm64" }), "nox-spacetimedb:candidate-arm64");
  for (const image of ["", " ", "candidate image", "candidate\n"])
    assert.throws(() => getSpacetimeImage({ NOX_BOT_SPACETIMEDB_IMAGE: image }));
});

test("manifest promotion rejects missing, duplicated or substituted architecture digests", () => {
  const expected = { amd64: `sha256:${"a".repeat(64)}`, arm64: `sha256:${"b".repeat(64)}` };
  const images = Object.entries(expected).map(([architecture, digest]) => ({ platform: { os: "linux", architecture }, digest }));
  verifyManifest({ manifests: images }, expected);
  assert.throws(() => verifyManifest({ manifests: images.slice(0, 1) }, expected));
  assert.throws(() => verifyManifest({ manifests: [images[0], images[0]] }, expected));
  assert.throws(() => verifyManifest({ manifests: [images[0], { ...images[1], digest: expected.amd64 }] }, expected));
  assert.throws(() => verifyManifest({ config: {} }, expected));
});
