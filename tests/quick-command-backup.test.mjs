import test from "node:test";
import assert from "node:assert/strict";
import { QuickCommandService } from "../dist/core/quickCommands.js";
import { StateError } from "../dist/core/state.js";
import { parseQuickCommandBackup } from "../dist/shared/quickCommandBackup.js";
import { memoryState } from "./fixtures/state.mjs";
import { quietLogger } from "./helpers.mjs";
quietLogger();
const revisions = (quick, guildId, commands) => {
  const existing = new Map(
    quick.list(guildId).map((row) => [row.data.trigger, row.revision]),
  );
  return Object.fromEntries(
    commands.map((command) => [
      command.trigger,
      existing.get(command.trigger) ?? "0",
    ]),
  );
};
test("backup roundtrip includes disabled commands and preserves exact responses across a different server/database", async (t) => {
  const f = await memoryState(t),
    quick = new QuickCommandService(f.state);
  await quick.save(
    "1",
    {
      guildId: "1",
      trigger: "HELLO",
      response: "  Olá!\nhttps://example.com/🙂  ",
      enabled: true,
    },
    "0",
  );
  await quick.save(
    "1",
    {
      guildId: "1",
      trigger: "hidden",
      response: "Disabled answer",
      enabled: false,
    },
    "0",
  );
  const backup = JSON.parse(JSON.stringify(quick.export("1")));
  assert.deepEqual(Object.keys(backup[0]), ["trigger", "response", "enabled"]);
  assert.equal(backup.length, 2);
  assert.equal(backup[1].enabled, false);
  await quick.save(
    "2",
    { guildId: "2", trigger: "hello", response: "Old answer", enabled: false },
    "0",
  );
  await quick.save(
    "2",
    { guildId: "2", trigger: "keep", response: "Keep this", enabled: true },
    "0",
  );
  assert.equal(
    await quick.import("2", backup, revisions(quick, "2", backup)),
    2,
  );
  assert.equal(quick.response("2", "hello"), backup[0].response);
  assert.equal(quick.response("2", "hidden"), undefined);
  assert.equal(quick.response("2", "keep"), "Keep this");
  const fresh = await memoryState(t),
    restored = new QuickCommandService(fresh.state);
  await restored.import("2", backup, revisions(restored, "2", backup));
  assert.deepEqual(restored.export("2"), backup);
  f.disconnect();
  assert.deepEqual(quick.export("1"), backup);
  await assert.rejects(
    quick.import("1", backup, revisions(quick, "1", backup)),
    { code: "STATE_UNAVAILABLE" },
  );
});
test("all entries and duplicate triggers are validated before writing any command", async (t) => {
  const f = await memoryState(t),
    quick = new QuickCommandService(f.state);
  const valid = { trigger: "hello", response: "Hello", enabled: true };
  const invalid = [
    null,
    {},
    { ...valid, guildId: "2" },
    { ...valid, revision: "0" },
    { ...valid, trigger: "help" },
    { ...valid, response: " " },
    { ...valid, enabled: "true" },
    { ...valid, response: "x".repeat(2001) },
    { ...valid, trigger: "x".repeat(33) },
  ];
  for (const command of invalid) {
    await assert.rejects(
      quick.import("1", [{ ...valid, trigger: "first" }, command], {
        first: "0",
        hello: "0",
      }),
      { code: "INVALID_STATE" },
    );
    assert.deepEqual(quick.export("1"), []);
  }
  assert.throws(
    () =>
      parseQuickCommandBackup([valid, { ...valid, trigger: " HELLO " }], "1"),
    /duplicates/,
  );
  assert.throws(
    () => parseQuickCommandBackup({ commands: [valid] }, "1"),
    /JSON array/,
  );
  assert.deepEqual(
    parseQuickCommandBackup([{ ...valid, trigger: " HELLO " }], "1"),
    [valid],
  );
});
test("import rejects stale or missing revisions without overwriting confirmed commands", async (t) => {
  const f = await memoryState(t),
    quick = new QuickCommandService(f.state);
  const entry = { trigger: "hello", response: "Original", enabled: true };
  await quick.save("1", { guildId: "1", ...entry }, "0");
  await assert.rejects(quick.import("1", [entry], { hello: "0" }), {
    code: "STATE_CONFLICT",
  });
  await assert.rejects(quick.import("1", [entry], {}), {
    code: "INVALID_STATE",
  });
  await assert.rejects(quick.import("1", [entry], { hello: 0 }), {
    code: "INVALID_STATE",
  });
  assert.equal(quick.response("1", "hello"), "Original");
});
test("large complete backups use one transaction and a failed commit never imports a partial list", async (t) => {
  const commands = Array.from({ length: 1001 }, (_, index) => ({
    trigger: `q${index}`,
    response: `Answer ${index}`,
    enabled: index % 2 === 0,
  }));
  const f = await memoryState(t),
    quick = new QuickCommandService(f.state);
  const mutate = f.transport.mutate.bind(f.transport),
    batches = [];
  f.transport.mutate = async (changes) => {
    batches.push(changes.length);
    await mutate(changes);
  };
  assert.equal(
    await quick.import("1", commands, revisions(quick, "1", commands)),
    1001,
  );
  assert.deepEqual(batches, [1001]);
  assert.equal(quick.export("1").length, 1001);
  const interrupted = await memoryState(t),
    partial = new QuickCommandService(interrupted.state);
  interrupted.transport.mutate = async () => {
    throw new StateError("STATE_UNAVAILABLE", "Disconnected");
  };
  await assert.rejects(
    partial.import("1", commands, revisions(partial, "1", commands)),
    { code: "STATE_UNAVAILABLE" },
  );
  assert.deepEqual(partial.export("1"), []);
});
