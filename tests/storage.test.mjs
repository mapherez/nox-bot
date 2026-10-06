import test from "node:test";
import assert from "node:assert/strict";
import { SpacetimeTransport } from "../dist/storage/spacetime.js";

test("confirmation timeout blocks mutations and requests a fresh snapshot without replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = new SpacetimeTransport({
    url: "http://127.0.0.1",
    database: "fixture",
    token: "fixture",
  });
  let attempts = 0,
    disconnected = 0;
  transport.connection = {
    isActive: true,
    db: { serviceDocuments: { iter: () => [][Symbol.iterator]() } },
    reducers: {
      mutateState: async () => {
        attempts++;
      },
    },
    disconnect: () => {},
  };
  transport.subscribed = true;
  transport.callbacks = {
    disconnected: () => {
      disconnected++;
    },
  };
  const change = {
    key: "guild:1:",
    kind: "guild",
    guildId: "1",
    value: '{"guildId":"1"}',
    expectedRevision: 0n,
  };
  const write = transport.mutate([change]);
  const rejection = assert.rejects(write, { code: "WRITE_UNCONFIRMED" });
  t.mock.timers.tick(10000);
  await rejection;
  assert.equal(disconnected, 1);
  assert.equal(attempts, 1);
  await assert.rejects(transport.mutate([change]), {
    code: "STATE_UNAVAILABLE",
  });
  assert.equal(attempts, 1);
  await transport.close();
});

test("a competing confirmed snapshot cannot turn a rejected reducer into a successful write", async () => {
  const transport = new SpacetimeTransport({
    url: "http://127.0.0.1",
    database: "fixture",
    token: "fixture",
  });
  let rejectReducer;
  const rows = [];
  const connection = {
    isActive: true,
    db: {
      serviceDocuments: { iter: () => rows.values() },
      serviceSequence: { iter: () => [{ revision: 2n }].values() },
    },
    reducers: {
      mutateState: () =>
        new Promise((resolve, reject) => {
          rejectReducer = reject;
        }),
    },
    disconnect: () => {},
  };
  transport.connection = connection;
  transport.subscribed = true;
  transport.callbacks = { snapshot: async () => {} };
  const change = {
    key: "guild:1:",
    kind: "guild",
    guildId: "1",
    value: '{"guildId":"1","name":"mine"}',
    expectedRevision: 1n,
  };
  let settled = false;
  const write = transport.mutate([change]);
  void write.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  rows.push({
    ...change,
    revision: 2n,
    value: '{"guildId":"1","name":"someone else"}',
  });
  transport.queueSnapshot(connection, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  rejectReducer(new Error("STATE_CONFLICT"));
  await assert.rejects(write, { code: "STATE_CONFLICT" });
  await transport.close();
});
test("a successful reducer waits for its matching confirmed data and completed projection", async () => {
  const transport = new SpacetimeTransport({
    url: "http://127.0.0.1",
    database: "fixture",
    token: "fixture",
  });
  let acknowledge, finishProjection;
  const rows = [];
  const connection = {
    isActive: true,
    db: {
      serviceDocuments: { iter: () => rows.values() },
      serviceSequence: { iter: () => [{ revision: 2n }].values() },
    },
    reducers: {
      mutateState: () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    },
    disconnect: () => {},
  };
  transport.connection = connection;
  transport.subscribed = true;
  transport.callbacks = {
    snapshot: () =>
      new Promise((resolve) => {
        finishProjection = resolve;
      }),
  };
  const change = {
    key: "guild:1:",
    kind: "guild",
    guildId: "1",
    value: '{"guildId":"1","name":"mine"}',
    expectedRevision: 1n,
  };
  let settled = false;
  const write = transport.mutate([change]).then(() => {
    settled = true;
  });
  acknowledge();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  rows.push({ ...change, revision: 2n });
  transport.queueSnapshot(connection, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishProjection();
  await write;
  assert.equal(settled, true);
  await transport.close();
});
