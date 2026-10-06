import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { legacyPlan, importLegacy } from "../dist/core/migration.js";
import { SecretVault } from "../dist/core/secrets.js";
import { memoryState } from "./fixtures/state.mjs";
test("legacy import is atomic, guild scoped and idempotent, with Weather pending until configured", async (t) => {
  const { state } = await memoryState(t),
    vault = new SecretVault(randomBytes(32).toString("base64")),
    plan = legacyPlan("1", { HELLO: "public response" });
  assert.equal(plan.summary.weather, "pending API key");
  assert.equal(await importLegacy(state, vault, plan), "imported");
  assert.equal(state.get("plugin", "1", "weather").data.enabled, false);
  assert.equal(state.get("plugin", "1", "dictionary").data.enabled, true);
  assert.equal(
    state.get("quick", "1", "hello").data.response,
    "public response",
  );
  assert.equal(state.list("plugin", "2").length, 0);
  const revision = state.revision;
  assert.equal(await importLegacy(state, vault, plan), "already-imported");
  assert.equal(state.revision, revision);
  const second = legacyPlan("2", {}, "private-key");
  await importLegacy(state, vault, second);
  assert.equal(state.get("plugin", "2", "weather").data.enabled, true);
  assert.equal(
    JSON.stringify(state.list("plugin")).includes("private-key"),
    false,
  );
  assert.throws(() => legacyPlan("", {}));
  assert.throws(() => legacyPlan("3", { hi: "one", HI: "two" }));
  assert.throws(() => legacyPlan("3", { help: "reserved" }));
});
