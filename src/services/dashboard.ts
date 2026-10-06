import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { AuthError, type AuthService } from "../core/auth.js";
import { StateError, isRecord, type StateStore } from "../core/state.js";
import {
  ControlError,
  errorStatuses,
  validateId,
  type DiscordOperationsContract,
} from "../controlApi.js";
import type { PluginManager } from "../plugins/manager.js";
import type { QuickCommandService } from "../core/quickCommands.js";
import type { GuildSnapshot } from "../shared/dashboard.js";
import Logger from "../utils/logger.js";

interface DashboardOptions {
  host: string;
  port: number;
  assets?: string;
}
const cookies = (request: IncomingMessage): Record<string, string> =>
  Object.fromEntries(
    (request.headers.cookie ?? "").split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index < 0
        ? []
        : [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
    }),
  );
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}
async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new AuthError(415, "INVALID_PAYLOAD", "Use application/json.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536)
      throw new AuthError(
        413,
        "PAYLOAD_TOO_LARGE",
        "The request is too large.",
      );
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (isRecord(value)) return value;
  } catch {
    /* Controlled validation response. */
  }
  throw new AuthError(400, "INVALID_PAYLOAD", "Expected a JSON object.");
}
function shape(
  value: Record<string, unknown>,
  fields: string[],
  required: string[] = fields,
): void {
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw new AuthError(
      400,
      "INVALID_PAYLOAD",
      "Unexpected or missing fields.",
    );
}
function revision(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new AuthError(
      400,
      "INVALID_PAYLOAD",
      "A valid expectedRevision is required.",
    );
  return value;
}
export class DashboardServer {
  private server = createServer(
    (request, response) => void this.handle(request, response),
  );
  private streams = new Set<ServerResponse>();
  private readonly assets: string;
  constructor(
    private readonly options: DashboardOptions,
    private readonly auth: AuthService,
    private readonly state: StateStore,
    private readonly operations: DiscordOperationsContract,
    private readonly plugins: PluginManager,
    private readonly quick: QuickCommandService,
    private readonly commandStatus: (guildId: string) => {
      state: string;
      error?: string;
    } = () => ({ state: "synced" }),
  ) {
    this.assets =
      options.assets ??
      fileURLToPath(new URL("../../web/dist", import.meta.url));
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
  }
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }
  address() {
    return this.server.address();
  }
  private async assertGuild(guildId: string): Promise<void> {
    validateId(guildId);
    if (
      !(await this.operations.listGuilds()).some(
        (guild) => guild.id === guildId,
      )
    )
      throw new ControlError(
        "GUILD_NOT_FOUND",
        "The bot is not installed in this server.",
      );
  }
  snapshot(guildId: string): GuildSnapshot {
    return {
      guildId,
      revision: this.state.revision,
      synchronization: this.state.synchronization,
      initialized: this.state.initialized,
      writable: this.state.writable,
      commandSynchronization: this.commandStatus(guildId),
      plugins: this.plugins.definitions().map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        icon: plugin.icon,
        dashboardEntry: plugin.dashboardEntry,
        configurable:
          Object.keys(plugin.defaults).length > 0 ||
          plugin.secretFields.length > 0,
        commands: plugin.commands.map(({ name, usage, description }) => ({
          name,
          usage,
          description,
        })),
        configuration: this.plugins.configuration(plugin.id, guildId),
      })),
      quickCommands: this.quick.list(guildId).map(({ revision, data }) => ({
        revision,
        trigger: data.trigger,
        response: data.response,
        enabled: data.enabled,
      })),
    };
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://cdn.discordapp.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const url = new URL(request.url ?? "/", "http://localhost"),
        method = request.method ?? "GET",
        jar = cookies(request),
        token = jar[this.auth.sessionCookieName];
      if (url.pathname === "/health" && method === "GET") {
        const ready =
          this.state.initialized &&
          this.operations.getStatus().discord?.ready === true;
        json(response, ready ? 200 : 503, {
          ready,
          synchronization: this.state.synchronization,
          configurationChangesAvailable: this.state.writable,
        });
        return;
      }
      if (url.pathname === "/auth/login" && method === "GET") {
        const login = this.auth.beginLogin();
        response.writeHead(302, {
          Location: login.url,
          "Set-Cookie": login.stateCookie,
          "Cache-Control": "no-store",
        });
        response.end();
        return;
      }
      if (url.pathname === "/auth/callback" && method === "GET") {
        try {
          const login = await this.auth.completeLogin(
            url.searchParams.get("code") ?? "",
            url.searchParams.get("state") ?? "",
            jar["nox-oauth-state"] ?? "",
            token,
          );
          response.writeHead(302, {
            Location: "/",
            "Set-Cookie": [login.cookie, this.auth.clearOAuthCookie()],
            "Cache-Control": "no-store",
          });
          response.end();
        } catch (error) {
          if (!(error instanceof AuthError)) throw error;
          response.writeHead(302, {
            Location: `/?auth=${error.code === "ACCESS_DENIED" ? "denied" : "failed"}`,
            "Set-Cookie": this.auth.clearOAuthCookie(),
            "Cache-Control": "no-store",
          });
          response.end();
        }
        return;
      }
      if (
        url.pathname.startsWith("/auth/") ||
        url.pathname.startsWith("/dashboard/api")
      ) {
        const session = this.auth.authenticate(
          token,
          url.pathname !== "/auth/logout",
        );
        if (!["GET", "HEAD"].includes(method))
          this.auth.validateMutation(
            session,
            request.headers.origin,
            typeof request.headers["x-csrf-token"] === "string"
              ? request.headers["x-csrf-token"]
              : undefined,
          );
        if (url.pathname === "/auth/logout" && method === "POST") {
          response.setHeader(
            "Set-Cookie",
            await this.auth.logout(token!, session),
          );
          json(response, 200, { ok: true });
          return;
        }
        if (url.pathname === "/dashboard/api/session" && method === "GET") {
          json(response, 200, {
            user: {
              id: session.userId,
              username: session.username,
              avatar: session.avatar,
            },
            csrf: session.csrf,
            expiresAt: session.expiresAt,
          });
          return;
        }
        if (url.pathname === "/dashboard/api/guilds" && method === "GET") {
          json(response, 200, await this.operations.listGuilds());
          return;
        }
        const match = /^\/dashboard\/api\/guilds\/([^/]+)(?:\/(.*))?$/.exec(
          url.pathname,
        );
        if (match) {
          const guildId = decodeURIComponent(match[1]),
            resource = match[2] ?? "";
          await this.assertGuild(guildId);
          if (!resource && method === "GET") {
            json(response, 200, this.snapshot(guildId));
            return;
          }
          if (resource === "channels" && method === "GET") {
            json(response, 200, await this.operations.listChannels(guildId));
            return;
          }
          if (resource === "events" && method === "GET") {
            this.stream(response, guildId, token!);
            return;
          }
          if (!this.state.writable && !["GET", "HEAD"].includes(method))
            throw new StateError(
              "STATE_UNAVAILABLE",
              "Reconnecting — configuration changes temporarily unavailable",
            );
          const plugin =
            /^plugins\/([a-z][a-z0-9-]{0,31})\/(enabled|settings)$/.exec(
              resource,
            );
          if (plugin && method === "PUT") {
            const input = await body(request);
            if (plugin[2] === "enabled") {
              shape(input, ["enabled", "expectedRevision"]);
              if (typeof input.enabled !== "boolean")
                throw new AuthError(
                  400,
                  "INVALID_PAYLOAD",
                  "enabled must be a boolean.",
                );
              await this.plugins.setEnabled(
                plugin[1],
                guildId,
                input.enabled,
                revision(input.expectedRevision),
              );
            } else {
              shape(
                input,
                ["settings", "secrets", "expectedRevision"],
                ["settings", "expectedRevision"],
              );
              if (
                input.secrets !== undefined &&
                (!isRecord(input.secrets) ||
                  Object.values(input.secrets).some(
                    (value) => value !== null && typeof value !== "string",
                  ))
              )
                throw new AuthError(400, "INVALID_PAYLOAD", "Invalid secrets.");
              await this.plugins.configure(plugin[1], guildId, {
                settings: input.settings,
                secrets: input.secrets as
                  Record<string, string | null> | undefined,
                expectedRevision: revision(input.expectedRevision),
              });
            }
            json(response, 200, this.snapshot(guildId));
            return;
          }
          const quick = /^quick-commands(?:\/([a-zA-Z0-9_-]{1,32}))?$/.exec(
            resource,
          );
          if (quick && (method === "POST" || method === "PUT")) {
            const input = await body(request);
            shape(input, [
              "trigger",
              "response",
              "enabled",
              "expectedRevision",
            ]);
            if (
              typeof input.trigger !== "string" ||
              typeof input.response !== "string" ||
              typeof input.enabled !== "boolean" ||
              (method === "PUT" &&
                quick[1]?.toLowerCase() !== input.trigger.toLowerCase())
            )
              throw new AuthError(
                400,
                "INVALID_PAYLOAD",
                "Invalid Quick Command.",
              );
            await this.quick.save(
              guildId,
              {
                guildId,
                trigger: input.trigger,
                response: input.response,
                enabled: input.enabled,
              },
              revision(input.expectedRevision),
            );
            json(response, 200, this.snapshot(guildId));
            return;
          }
          if (quick?.[1] && method === "DELETE") {
            const input = await body(request);
            shape(input, ["expectedRevision"]);
            await this.quick.delete(
              guildId,
              quick[1],
              revision(input.expectedRevision),
            );
            json(response, 200, this.snapshot(guildId));
            return;
          }
        }
        throw new AuthError(404, "ROUTE_NOT_FOUND", "Route not found.");
      }
      if (method !== "GET" && method !== "HEAD")
        throw new AuthError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ""),
        filename = resolve(this.assets, relative || "index.html");
      if (!filename.startsWith(`${resolve(this.assets)}${sep}`))
        throw new AuthError(404, "ROUTE_NOT_FOUND", "Route not found.");
      let data: Buffer;
      try {
        data = await readFile(filename);
      } catch {
        if (extname(relative))
          throw new AuthError(404, "ROUTE_NOT_FOUND", "Asset not found.");
        data = await readFile(resolve(this.assets, "index.html"));
      }
      const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      response.writeHead(200, {
        "Content-Type": mime[extname(filename)] ?? "text/html; charset=utf-8",
        "Cache-Control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      });
      response.end(method === "HEAD" ? undefined : data);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof AuthError)
        json(response, error.status, {
          code: error.code,
          message: error.message,
        });
      else if (error instanceof StateError)
        json(
          response,
          error.code === "STATE_CONFLICT"
            ? 409
            : error.code === "INVALID_STATE"
              ? 400
              : 503,
          { code: error.code, message: error.message },
        );
      else if (error instanceof ControlError)
        json(response, errorStatuses[error.code], {
          code: error.code,
          message: error.message,
        });
      else {
        Logger.warn("Dashboard operation failed.");
        json(response, 400, {
          code: "INVALID_REQUEST",
          message:
            "The request could not be completed. Check the configuration and try again.",
        });
      }
    }
  }
  private stream(
    response: ServerResponse,
    guildId: string,
    token: string,
  ): void {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.streams.add(response);
    let sending = false,
      dirty = false;
    const send = async () => {
      if (sending) {
        dirty = true;
        return;
      }
      sending = true;
      try {
        this.auth.authenticate(token, false);
        await this.assertGuild(guildId);
        if (!response.destroyed) {
          const payload = `event: snapshot\ndata: ${JSON.stringify(this.snapshot(guildId))}\n\n`;
          if (response.writableLength > 1024 * 1024) response.end();
          else response.write(payload);
        }
      } catch {
        response.end();
      } finally {
        sending = false;
        if (dirty && !response.destroyed) {
          dirty = false;
          void send();
        }
      }
    };
    const update = () => void send();
    const heartbeat = setInterval(update, 20000);
    heartbeat.unref();
    this.state.on("change", update);
    this.state.on("sync", update);
    this.plugins.on("change", update);
    response.once("close", () => {
      clearInterval(heartbeat);
      this.state.off("change", update);
      this.state.off("sync", update);
      this.plugins.off("change", update);
      this.streams.delete(response);
    });
    update();
  }
  stop(): Promise<void> {
    for (const stream of this.streams) stream.end();
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeIdleConnections();
    });
  }
  forceClose(): void {
    for (const stream of this.streams) stream.destroy();
    this.server.closeAllConnections();
  }
}
