import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { StateStore } from "../../dist/core/state.js";
import { SqliteTransport } from "../../dist/storage/sqlite.js";
export async function sqliteFixture(t, retryMs = 20) {
  await mkdir(".tmp", { recursive: true });
  const directory = await mkdtemp(resolve(".tmp/sqlite-test-"));
  const filename = join(directory, "data", "nox-bot.sqlite"),
    stores = [],
    beforeClose = [];
  const create = () => {
    const transport = new SqliteTransport({ filename }, retryMs),
      state = new StateStore(transport);
    stores.push(state);
    return { state, transport };
  };
  t.after(async () => {
    for (const work of [...beforeClose].reverse()) await work();
    await Promise.allSettled(stores.map((state) => state.close()));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    filename,
    create,
    beforeClose: (work) => beforeClose.push(work),
    ...create(),
  };
}
export async function untilSqlite(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("SQLite integration condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
