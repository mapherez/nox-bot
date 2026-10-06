import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AuthService, loadAuthConfig } from "../dist/core/auth.js";
import { memoryState } from "./fixtures/state.mjs";

test("owner configuration, bound expiring OAuth state, session rotation and absolute expiry are enforced", async (t) => {
  const { state } = await memoryState(t);
  const env = {
    DISCORD_CLIENT_ID: "9",
    DISCORD_CLIENT_SECRET: "fixture",
    NOX_BOT_OWNER_DISCORD_USER_ID: "7",
    NOX_BOT_PUBLIC_URL: "https://bot.example.com",
    NOX_BOT_SESSION_SECRET: randomBytes(32).toString("base64"),
  };
  assert.throws(() =>
    loadAuthConfig({ ...env, NOX_BOT_OWNER_DISCORD_USER_ID: undefined }),
  );
  assert.throws(() =>
    loadAuthConfig({ ...env, NOX_BOT_PUBLIC_URL: "http://bot.example.com" }),
  );
  let clock = 1000000,
    identified = 0;
  const auth = new AuthService(
    state,
    loadAuthConfig(env),
    {
      authorizeURL: (state) => `https://discord.example?state=${state}`,
      identify: async () => {
        identified++;
        return { id: "7", username: "Owner", avatar: null };
      },
    },
    () => clock,
  );
  await auth.initializeOwner();
  const begin = () => new URL(auth.beginLogin().url).searchParams.get("state");
  let login = begin();
  await assert.rejects(
    auth.completeLogin("code", login, "different-browser-state"),
    { code: "OAUTH_STATE_INVALID" },
  );
  await assert.rejects(auth.completeLogin("code", login, login), {
    code: "OAUTH_STATE_INVALID",
  });
  login = begin();
  clock += 300001;
  await assert.rejects(auth.completeLogin("code", login, login), {
    code: "OAUTH_STATE_INVALID",
  });
  assert.equal(identified, 0);
  login = begin();
  const first = await auth.completeLogin("code", login, login);
  const token = first.cookie.split(";")[0].split("=")[1];
  login = begin();
  const renewed = await auth.completeLogin("code", login, login, token);
  const active = renewed.cookie.split(";")[0].split("=")[1];
  assert.notEqual(active, token);
  assert.throws(() => auth.authenticate(token), { code: "SESSION_EXPIRED" });
  for (let hour = 0; hour < 26; hour++) {
    clock += 55 * 60 * 1000;
    assert.equal(auth.authenticate(active).userId, "7");
    await new Promise((resolve) => setImmediate(resolve));
  }
  clock += 11 * 60 * 1000;
  assert.throws(() => auth.authenticate(active), { code: "SESSION_EXPIRED" });
});
