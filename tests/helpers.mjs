import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import Logger from "../dist/utils/logger.js";

// Node 22's process-isolated runner can corrupt its IPC stream when ordinary stdout
// contains multibyte logging. Keep routine application logs out of the test runner.
export function quietLogger() {
  for (const method of ["info", "success", "warn", "error", "debug"]) mock.method(Logger, method, () => {});
}

export const key = "control-api-test-key-distinct-from-discord";
export const env = { DISCORD_TOKEN: `MT${"x".repeat(60)}`, CLIENT_ID: "123456789", NOX_DISCORD_API_ENABLED: "false" };
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function until(predicate) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error("Condition not reached.");
}
export function fakeOperations() {
  return {
    getStatus: () => ({ discord: { state: "connected", ready: true, pingMs: 42 }, bot: { id: "7", username: "NoX" }, guildCount: 1 }),
    listGuilds: async () => [{ id: "1", name: "Guild" }],
    listChannels: async () => [{ id: "2", name: "general", type: "text" }],
    sendMessage: async (channelId) => ({ messageId: "3", channelId, guildId: "1" }),
  };
}
