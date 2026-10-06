import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { StateStore, stateKey } from "../dist/core/state.js";
import { SecretVault } from "../dist/core/secrets.js";
class Transport {
  rows = new Map();
  sequence = 0n;
  generation = 1;
  async connect(callbacks) {
    this.callbacks = callbacks;
    await this.snapshot();
  }
  async snapshot() {
    await this.callbacks.snapshot(
      [...this.rows.values()],
      this.sequence,
      this.generation,
    );
  }
  async mutate(changes) {
    for (const c of changes)
      if ((this.rows.get(c.key)?.revision ?? 0n) !== c.expectedRevision)
        throw Object.assign(new Error("Conflict"), { code: "STATE_CONFLICT" });
    this.sequence++;
    for (const c of changes)
      c.value === null
        ? this.rows.delete(c.key)
        : this.rows.set(c.key, { ...c, revision: this.sequence });
    await this.snapshot();
  }
  async close() {}
}
test("confirmed Quick Commands are isolated, editable immediately and remain available through database loss", async () => {
  const transport = new Transport(),
    store = new StateStore(transport);
  await store.start();
  await store.put("quick", "1", "hello", {
    guildId: "1",
    trigger: "hello",
    response: "Hello A",
    enabled: true,
  });
  await store.put("quick", "2", "hello", {
    guildId: "2",
    trigger: "hello",
    response: "Hello B",
    enabled: true,
  });
  assert.equal(store.get("quick", "1", "hello").data.response, "Hello A");
  assert.equal(store.get("quick", "2", "hello").data.response, "Hello B");
  transport.callbacks.disconnected();
  assert.equal(store.synchronization, "reconnecting");
  assert.equal(store.initialized, true);
  assert.equal(store.get("quick", "1", "hello").data.response, "Hello A");
  await assert.rejects(store.remove("quick", "1", "hello", "1"), {
    code: "STATE_UNAVAILABLE",
  });
  transport.rows.delete(stateKey("quick", "1", "hello"));
  transport.sequence++;
  transport.generation++;
  transport.callbacks.recovering();
  await transport.snapshot();
  assert.equal(store.writable, true);
  assert.equal(store.get("quick", "1", "hello"), undefined);
  assert.equal(store.get("quick", "2", "hello").data.response, "Hello B");
  await store.close();
});
test("unconfirmed and rejected writes never update the confirmed projection", async () => {
  const transport = new Transport(),
    store = new StateStore(transport);
  await store.start();
  transport.mutate = async () => {
    throw Object.assign(new Error("Unknown outcome"), {
      code: "WRITE_UNCONFIRMED",
    });
  };
  await assert.rejects(
    store.put("quick", "1", "hello", {
      guildId: "1",
      trigger: "hello",
      response: "unconfirmed",
      enabled: true,
    }),
  );
  assert.deepEqual(store.list("quick"), []);
  await store.close();
});
test("old connections and regressing revisions cannot overwrite the latest projection", async () => {
  const transport = new Transport(),
    store = new StateStore(transport);
  await store.start();
  await store.put("quick", "1", "hello", {
    guildId: "1",
    trigger: "hello",
    response: "latest",
    enabled: true,
  });
  transport.generation = 3;
  transport.callbacks.recovering();
  await transport.snapshot();
  await transport.callbacks.snapshot([], 99n, 2);
  assert.equal(store.get("quick", "1", "hello").data.response, "latest");
  await transport.callbacks.snapshot([], 0n, 3);
  assert.equal(store.get("quick", "1", "hello").data.response, "latest");
  await store.close();
});
test("writes remain closed until lifecycle projections finish, including a second socket loss", async () => {
  const transport = new Transport(),
    store = new StateStore(transport);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  store.addProjection(() => gate);
  const starting = store.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.writable, false);
  transport.callbacks.disconnected();
  release();
  await starting;
  assert.equal(store.writable, false);
  assert.equal(store.synchronization, "reconnecting");
  await store.close();
});
test("plugin secrets are encrypted with guild/plugin/field binding", () => {
  const vault = new SecretVault(randomBytes(32).toString("base64"));
  const encrypted = vault.encrypt(
    "private-weather-key",
    "1",
    "weather",
    "apiKey",
  );
  assert.equal(encrypted.includes("private-weather-key"), false);
  assert.equal(
    vault.decrypt(encrypted, "1", "weather", "apiKey"),
    "private-weather-key",
  );
  assert.throws(() => vault.decrypt(encrypted, "2", "weather", "apiKey"));
  assert.throws(() => vault.decrypt(encrypted, "1", "dictionary", "apiKey"));
  assert.throws(() => new SecretVault("short"));
});
