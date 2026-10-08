import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AuthService, DiscordOAuth, loadAuthConfig } from "../dist/core/auth.js";
import { memoryState } from "./fixtures/state.mjs";

const YEAR = 365 * 24 * 60 * 60 * 1000;

const configEnv = (origin = "https://bot.example.com") => ({
  DISCORD_CLIENT_ID: "9",
  DISCORD_CLIENT_SECRET: "fixture",
  NOX_BOT_OWNER_DISCORD_USER_ID: "7",
  NOX_BOT_PUBLIC_URL: origin,
  NOX_BOT_SESSION_SECRET: randomBytes(32).toString("base64"),
});

test("dashboard origins allow HTTPS, loopback HTTP and private LAN HTTP only", () => {
  for (const origin of [
    "https://bot.example.com", "https://8.8.8.8:3200", "https://192.168.1.50:3200",
    "http://localhost:3200", "http://127.0.0.1", "http://127.255.255.254:3200",
    "http://[::1]:3200", "http://[0:0:0:0:0:0:0:1]:3200",
    "http://10.0.0.1:3200", "http://10.255.255.254:3200",
    "http://172.16.0.1:3200", "http://172.31.255.254:3200",
    "http://192.168.0.1:3200", "http://192.168.255.254:3200",
    "http://[fc00::1]:3200", "http://[fdff:ffff::1]:3200",
  ]) {
    assert.equal(loadAuthConfig(configEnv(origin)).origin, new URL(origin).origin, origin);
  }
  for (const origin of [
    "http://bot.example.com", "http://8.8.8.8:3200", "http://0.0.0.0:3200",
    "http://172.15.255.254", "http://172.32.0.1", "http://192.167.1.1", "http://192.169.1.1",
    "http://localhost.example.com", "http://192.168.1.50.example.com", "http://10.example.com",
    "http://[2001:db8::1]:3200", "http://[fbff::1]:3200", "http://[fe00::1]:3200",
    "ftp://192.168.1.50", "http://owner:password@192.168.1.50:3200",
    "http://192.168.1.50:3200/dashboard", "http://192.168.1.50:3200/?q=1",
    "http://192.168.1.50:3200/#fragment", "not a URL",
  ]) {
    assert.throws(() => loadAuthConfig(configEnv(origin)), undefined, origin);
  }
});

test("LAN login retains owner authorization, cookie flags and exact CSRF origin", async (t) => {
  const { state } = await memoryState(t);
  const config = loadAuthConfig(configEnv("http://192.168.1.50:3200"));
  const discord = new DiscordOAuth(config);
  let userId = "7";
  const auth = new AuthService(state, config, {
    authorizeURL: (token) => discord.authorizeURL(token),
    identify: async () => ({ id: userId, username: "Owner", avatar: null }),
  });
  await auth.initializeOwner();
  const login = auth.beginLogin();
  const url = new URL(login.url);
  assert.equal(url.searchParams.get("redirect_uri"), `${config.origin}/auth/callback`);
  assert.match(login.stateCookie, /; HttpOnly; SameSite=Lax;/);
  assert.doesNotMatch(login.stateCookie, /; Secure/);
  const token = url.searchParams.get("state");
  const signed = await auth.completeLogin("code", token, token);
  assert.match(signed.cookie, /^nox-session=/);
  assert.match(signed.cookie, /; HttpOnly; SameSite=Lax;/);
  assert.doesNotMatch(signed.cookie, /; Secure/);
  assert.equal(auth.authenticate(signed.cookie.split(";")[0].split("=")[1]).userId, "7");
  auth.validateMutation(signed.session, config.origin, signed.session.csrf);
  for (const origin of ["http://192.168.1.51:3200", "http://192.168.1.50:3201", "https://192.168.1.50:3200", undefined])
    assert.throws(() => auth.validateMutation(signed.session, origin, signed.session.csrf), { code: "CSRF_INVALID" });
  assert.throws(() => auth.validateMutation(signed.session, config.origin, "invalid"), { code: "CSRF_INVALID" });
  userId = "8";
  const denied = new URL(auth.beginLogin().url).searchParams.get("state");
  await assert.rejects(auth.completeLogin("code", denied, denied), { code: "ACCESS_DENIED" });

  const httpsConfig = loadAuthConfig(configEnv("https://192.168.1.50:3200"));
  const httpsAuth = new AuthService(state, httpsConfig, new DiscordOAuth(httpsConfig));
  assert.equal(httpsAuth.sessionCookieName, "__Host-nox-session");
  const httpsLogin = httpsAuth.beginLogin();
  assert.match(httpsLogin.stateCookie, /; Secure/);
  assert.equal(new URL(httpsLogin.url).searchParams.get("redirect_uri"), `${httpsConfig.origin}/auth/callback`);
});

test("owner configuration, expiring OAuth state, session rotation and rolling one-year expiry are enforced", async (t) => {
  const { state } = await memoryState(t);
  const env = configEnv();
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
  assert.match(first.cookie, /; Max-Age=31536000; Secure$/);
  assert.equal(first.session.expiresAt - first.session.createdAt, YEAR);
  const token = first.cookie.split(";")[0].split("=")[1];
  login = begin();
  const renewed = await auth.completeLogin("code", login, login, token);
  const active = renewed.cookie.split(";")[0].split("=")[1];
  assert.notEqual(active, token);
  assert.throws(() => auth.authenticate(token), { code: "SESSION_EXPIRED" });
  clock += 180 * 24 * 60 * 60 * 1000;
  assert.equal(auth.authenticate(active, false).userId, "7");
  assert.equal(auth.authenticate(active).userId, "7");
  const refreshed = await auth.refreshSession(active);
  assert.match(refreshed.cookie, /; Max-Age=31536000; Secure$/);
  assert.equal(refreshed.session.expiresAt, clock + YEAR);
  assert.equal(state.get("session", "", refreshed.session.hash).data.expiresAt, clock + YEAR);
  clock = renewed.session.expiresAt + 1;
  assert.equal(auth.authenticate(active, false).userId, "7");
  clock = refreshed.session.expiresAt;
  assert.throws(() => auth.authenticate(active), { code: "SESSION_EXPIRED" });
});

test("cookie renewal follows confirmed expiry during outages and failed writes, then recovers", async (t) => {
  for (const failure of ["offline", "write-failed"]) {
    await t.test(failure, async (t) => {
      const f = await memoryState(t);
      let clock = 1000000;
      const config = loadAuthConfig(configEnv());
      const oauth = {
        authorizeURL: (state) => `https://discord.example?state=${state}`,
        identify: async () => ({ id: "7", username: "Owner", avatar: null }),
      };
      const auth = new AuthService(f.state, config, oauth, () => clock);
      await auth.initializeOwner();
      const login = new URL(auth.beginLogin().url).searchParams.get("state");
      const signed = await auth.completeLogin("code", login, login);
      const token = signed.cookie.split(";")[0].split("=")[1];
      const mutate = f.transport.mutate;
      if (failure === "offline") f.disconnect();
      else f.transport.mutate = async () => { throw new Error("write failed"); };
      clock += 6 * 24 * 60 * 60 * 1000;
      auth.authenticate(token);
      const unchanged = await auth.refreshSession(token);
      assert.equal(unchanged.session.expiresAt, signed.session.expiresAt);
      assert.match(unchanged.cookie, /; Max-Age=31017600; Secure$/);

      f.transport.mutate = mutate;
      await f.recover();
      auth.authenticate(token);
      const renewed = await auth.refreshSession(token);
      assert.equal(renewed.session.expiresAt, clock + YEAR);
      assert.match(renewed.cookie, /; Max-Age=31536000; Secure$/);
      const restarted = new AuthService(f.state, config, oauth, () => clock);
      clock = signed.session.expiresAt + 1;
      assert.equal(restarted.authenticate(token, false).userId, "7");
      clock = renewed.session.expiresAt;
      assert.throws(() => restarted.authenticate(token, false), { code: "SESSION_EXPIRED" });
    });
  }
});
