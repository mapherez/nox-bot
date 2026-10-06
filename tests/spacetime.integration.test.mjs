import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DbConnection, tables } from "../dist/storage/bindings/index.js";
import { SpacetimeTransport } from "../dist/storage/spacetime.js";
import { StateStore } from "../dist/core/state.js";
import { provisionState } from "../scripts/provision-state.mjs";
const url = process.env.NOX_BOT_TEST_STATE_URL;
test(
  "self-hosted SpacetimeDB: private views, authorized writes, revisions and realtime across two subscribers",
  { skip: !url, timeout: 30000 },
  async (t) => {
    const database =
      process.env.NOX_BOT_TEST_STATE_DATABASE ?? "nox-bot-integration";
    const credentialFile =
      process.env.NOX_BOT_TEST_STATE_CREDENTIAL_FILE ??
      ".tmp/state-integration/credentials.json";
    const { token } = await provisionState({
      url,
      database,
      credentialFile,
      bundle: "spacetimedb/dist/bundle.js",
    });
    const stores = [
      new StateStore(new SpacetimeTransport({ url, database, token })),
      new StateStore(new SpacetimeTransport({ url, database, token })),
    ];
    t.after(() => Promise.all(stores.map((s) => s.close())));
    await Promise.all(stores.map((s) => s.start()));
    const [a, b] = stores,
      trigger = `test_${Date.now()}`;
    await a.put("quick", "1", trigger, {
      guildId: "1",
      trigger,
      response: "confirmed",
      enabled: true,
    });
    const deadline = Date.now() + 5000;
    while (!b.get("quick", "1", trigger) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.get("quick", "1", trigger).data.response, "confirmed");
    await assert.rejects(
      a.put(
        "quick",
        "1",
        trigger,
        { guildId: "1", trigger, response: "stale", enabled: true },
        "0",
      ),
      { code: "STATE_CONFLICT" },
    );
    assert.equal(a.get("quick", "2", trigger), undefined);
    await a.remove(
      "quick",
      "1",
      trigger,
      a.get("quick", "1", trigger).revision,
    );
    await new Promise((resolve, reject) => {
      const anonymous = DbConnection.builder()
        .withUri(url)
        .withDatabaseName(database)
        .onConnect((conn) => {
          conn
            .subscriptionBuilder()
            .onApplied(async () => {
              try {
                assert.deepEqual([...conn.db.serviceDocuments.iter()], []);
                assert.deepEqual([...conn.db.serviceSequence.iter()], []);
                await assert.rejects(
                  conn.reducers.mutateState({ changes: [] }),
                );
                resolve();
              } catch (error) {
                reject(error);
              } finally {
                conn.disconnect();
              }
            })
            .onError(reject)
            .subscribe([tables.serviceDocuments, tables.serviceSequence]);
        })
        .onConnectError(reject)
        .build();
      t.after(() => anonymous.disconnect());
    });
    const c = JSON.parse(await readFile(credentialFile, "utf8"));
    const privateQuery = await fetch(`${url}/v1/database/${database}/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.service.token}` },
      body: "SELECT * FROM state_document",
    });
    assert.equal(privateQuery.ok, false);
  },
);
