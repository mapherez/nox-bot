import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import type { Session, StateStore } from "./state.js";
import { registerSecret } from "../utils/logger.js";
import { validateId } from "../controlApi.js";

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  ownerId: string;
  origin: string;
  sessionSecret: string;
}
export interface DiscordIdentity {
  id: string;
  username: string;
  avatar: string | null;
}
export interface OAuthProvider {
  authorizeURL(state: string): string;
  identify(code: string): Promise<DiscordIdentity>;
}
export class AuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function allowsHttp(hostname: string): boolean {
  // URL.hostname is normalized, but IPv6 literals still include brackets.
  const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (host === "localhost") return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number);
    return (
      first === 127 ||
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return isIP(host) === 6 && (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host));
}
export function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  for (const name of [
    "DISCORD_CLIENT_ID",
    "DISCORD_CLIENT_SECRET",
    "NOX_BOT_OWNER_DISCORD_USER_ID",
    "NOX_BOT_PUBLIC_URL",
    "NOX_BOT_SESSION_SECRET",
  ])
    if (!env[name]) throw new Error(`${name} is required for the dashboard.`);
  const origin = new URL(env.NOX_BOT_PUBLIC_URL!);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && allowsHttp(origin.hostname)))
  )
    throw new Error(
      "Dashboard URL must be an HTTPS origin, or HTTP on localhost or a private LAN IP.",
    );
  validateId(env.DISCORD_CLIENT_ID);
  validateId(env.NOX_BOT_OWNER_DISCORD_USER_ID);
  const bytes = Buffer.from(env.NOX_BOT_SESSION_SECRET!, "base64");
  if (
    bytes.length !== 32 ||
    bytes.toString("base64") !== env.NOX_BOT_SESSION_SECRET
  )
    throw new Error(
      "NOX_BOT_SESSION_SECRET must be a canonical base64 encoded 32-byte key.",
    );
  registerSecret(env.DISCORD_CLIENT_SECRET!);
  registerSecret(env.NOX_BOT_SESSION_SECRET!);
  return {
    clientId: env.DISCORD_CLIENT_ID!,
    clientSecret: env.DISCORD_CLIENT_SECRET!,
    ownerId: env.NOX_BOT_OWNER_DISCORD_USER_ID!,
    origin: origin.origin,
    sessionSecret: env.NOX_BOT_SESSION_SECRET!,
  };
}
export class DiscordOAuth implements OAuthProvider {
  constructor(
    private readonly config: AuthConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  authorizeURL(state: string): string {
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: `${this.config.origin}/auth/callback`,
      response_type: "code",
      scope: "identify",
      state,
    }).toString();
    return url.toString();
  }
  async identify(code: string): Promise<DiscordIdentity> {
    const token = await this.request("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${this.config.origin}/auth/callback`,
      }),
    });
    if (!token.ok)
      throw new AuthError(
        401,
        "OAUTH_FAILED",
        "Discord authentication failed.",
      );
    const payload: unknown = await token.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !("access_token" in payload) ||
      typeof payload.access_token !== "string"
    )
      throw new AuthError(
        401,
        "OAUTH_FAILED",
        "Discord authentication failed.",
      );
    registerSecret(payload.access_token);
    const response = await this.request("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${payload.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new AuthError(
        401,
        "OAUTH_FAILED",
        "Discord identity could not be verified.",
      );
    const user: unknown = await response.json();
    if (
      !user ||
      typeof user !== "object" ||
      !("id" in user) ||
      !("username" in user) ||
      !("avatar" in user) ||
      typeof user.id !== "string" ||
      typeof user.username !== "string" ||
      (user.avatar !== null && typeof user.avatar !== "string")
    )
      throw new AuthError(
        401,
        "OAUTH_FAILED",
        "Discord identity could not be verified.",
      );
    validateId(user.id);
    return { id: user.id, username: user.username, avatar: user.avatar };
  }
}
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const SESSION_AGE = 24 * 60 * 60 * 1000,
  IDLE_AGE = 60 * 60 * 1000;

export class AuthService {
  private pending = new Map<string, number>();
  private activity = new Map<string, number>();
  private touches = new Map<string, Promise<void>>();
  private closing = new Set<string>();
  private revoked = new Set<string>();
  readonly secureCookie: boolean;
  readonly sessionCookieName: string;
  constructor(
    private readonly state: StateStore,
    private readonly config: AuthConfig,
    private readonly oauth: OAuthProvider,
    private readonly now = Date.now,
  ) {
    this.secureCookie = config.origin.startsWith("https:");
    this.sessionCookieName = this.secureCookie
      ? "__Host-nox-session"
      : "nox-session";
  }
  async initializeOwner(): Promise<void> {
    const existing = this.state.get("user", "", this.config.ownerId);
    if (!existing)
      await this.state.put(
        "user",
        "",
        this.config.ownerId,
        { userId: this.config.ownerId, role: "owner" },
        "0",
      );
  }
  beginLogin(): { url: string; stateCookie: string } {
    if (!this.state.writable)
      throw new AuthError(
        503,
        "STATE_UNAVAILABLE",
        "Login is temporarily unavailable while state synchronization recovers.",
      );
    for (const [token, expires] of this.pending)
      if (expires < this.now()) this.pending.delete(token);
    if (this.pending.size >= 1000)
      throw new AuthError(429, "LOGIN_BUSY", "Please try signing in later.");
    const token = randomBytes(32).toString("base64url");
    this.pending.set(hash(token), this.now() + 5 * 60 * 1000);
    return {
      url: this.oauth.authorizeURL(token),
      stateCookie: this.cookie("nox-oauth-state", token, 300),
    };
  }
  async completeLogin(
    code: string,
    state: string,
    cookieState: string,
    previousToken?: string,
  ): Promise<{ cookie: string; session: Session }> {
    const expires = this.pending.get(hash(state));
    this.pending.delete(hash(state));
    if (
      !code ||
      !state ||
      !cookieState ||
      !equal(state, cookieState) ||
      !expires ||
      expires < this.now()
    )
      throw new AuthError(
        401,
        "OAUTH_STATE_INVALID",
        "Invalid or expired login request.",
      );
    const identity = await this.oauth.identify(code);
    if (
      identity.id !== this.config.ownerId ||
      this.state.get("user", "", identity.id)?.data.role !== "owner"
    )
      throw new AuthError(
        403,
        "ACCESS_DENIED",
        "This dashboard is restricted to its owner.",
      );
    const token = randomBytes(32).toString("base64url");
    registerSecret(token);
    const csrf = createHmac("sha256", this.config.sessionSecret)
      .update(token)
      .digest("base64url");
    const session: Session = {
      hash: hash(token),
      userId: identity.id,
      username: identity.username,
      avatar: identity.avatar,
      csrf,
      createdAt: this.now(),
      expiresAt: this.now() + SESSION_AGE,
      lastSeenAt: this.now(),
    };
    const changes = [
      this.state.change("session", "", session.hash, session, "0"),
    ];
    if (previousToken) await this.touches.get(hash(previousToken));
    const previous = previousToken
      ? this.state.get("session", "", hash(previousToken))
      : undefined;
    if (previous && previousToken)
      changes.push(
        this.state.change(
          "session",
          "",
          hash(previousToken),
          null,
          previous.revision,
        ),
      );
    await this.state.commit(changes);
    if (previousToken) this.revoked.add(hash(previousToken));
    return {
      cookie: this.cookie(this.sessionCookieName, token, SESSION_AGE / 1000),
      session,
    };
  }
  authenticate(token: string | undefined, touch = true): Session {
    if (!token || token.length > 128)
      throw new AuthError(
        401,
        "AUTH_REQUIRED",
        "Sign in with Discord to continue.",
      );
    const sessionHash = hash(token),
      session = this.state.get("session", "", sessionHash)?.data;
    if (
      !session ||
      this.revoked.has(sessionHash) ||
      session.userId !== this.config.ownerId ||
      this.state.get("user", "", session.userId)?.data.role !== "owner" ||
      session.expiresAt <= this.now() ||
      Math.max(session.lastSeenAt, this.activity.get(sessionHash) ?? 0) +
        IDLE_AGE <=
        this.now()
    )
      throw new AuthError(
        401,
        "SESSION_EXPIRED",
        "Your session has expired. Sign in again.",
      );
    if (touch) this.activity.set(sessionHash, this.now());
    if (
      touch &&
      this.state.writable &&
      this.now() - session.lastSeenAt > 5 * 60 * 1000 &&
      !this.closing.has(sessionHash) &&
      !this.touches.has(sessionHash)
    ) {
      const current = this.state.get("session", "", sessionHash)!;
      const updating = this.state
        .put(
          "session",
          "",
          sessionHash,
          { ...session, lastSeenAt: this.now() },
          current.revision,
        )
        .catch(() => {})
        .finally(() => {
          this.touches.delete(sessionHash);
        });
      this.touches.set(sessionHash, updating);
    }
    return session;
  }
  validateMutation(
    session: Session,
    origin: string | undefined,
    csrf: string | undefined,
  ): void {
    if (origin !== this.config.origin || !csrf || !equal(session.csrf, csrf))
      throw new AuthError(
        403,
        "CSRF_INVALID",
        "The request could not be verified. Refresh the page and try again.",
      );
  }
  async logout(token: string, session: Session): Promise<string> {
    this.closing.add(session.hash);
    try {
      await this.touches.get(session.hash);
      const revision = this.state.get("session", "", session.hash)?.revision;
      if (revision)
        await this.state.remove("session", "", session.hash, revision);
      this.revoked.add(hash(token));
      this.activity.delete(session.hash);
      return this.cookie(this.sessionCookieName, "", 0);
    } finally {
      this.closing.delete(session.hash);
    }
  }
  clearOAuthCookie(): string {
    return this.cookie("nox-oauth-state", "", 0);
  }
  private cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secureCookie ? "; Secure" : ""}`;
  }
}
