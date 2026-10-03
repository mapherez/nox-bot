import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ControlError, errorStatuses, validateId, validateMessage,
  type ControlApiConfig, type DiscordOperationsContract, type ProcessState, type ServiceInfo,
} from "../controlApi.js";
import Logger from "../utils/logger.js";

const digest = (value: string) => createHash("sha256").update(value).digest();
const MAX_BODY = 16 * 1024;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAbort);
      request.off("error", onError);
    };
    const fail = (error: unknown) => { cleanup(); request.resume(); reject(error); };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) return fail(new ControlError("PAYLOAD_TOO_LARGE", "Request body exceeds 16 KiB."));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ControlError("INVALID_PAYLOAD", "Invalid JSON body.")); }
    };
    const onAbort = () => fail(new ControlError("INVALID_PAYLOAD", "Request body was interrupted."));
    const onError = () => fail(new ControlError("INVALID_PAYLOAD", "Request body could not be read."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAbort);
    request.once("error", onError);
  });
}

export default class ControlApi {
  private readonly keyDigest: Buffer;
  private readonly server;
  private readonly active = new Set<Promise<void>>();
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private draining = false;
  private started = false;

  constructor(
    private readonly config: ControlApiConfig,
    private readonly operations: DiscordOperationsContract,
    private readonly info: ServiceInfo,
    private readonly processState: () => ProcessState,
    onFatal: (error: unknown) => void = (error) => Logger.error("Control API server failed:", error),
  ) {
    if (!config.key) throw new Error("Control API requires its own key.");
    this.keyDigest = digest(config.key);
    this.server = createServer((request, response) => {
      const work = this.handle(request, response);
      this.active.add(work);
      void work.then(() => this.active.delete(work), () => this.active.delete(work));
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
    this.server.on("error", (error) => { if (this.started) onFatal(error); });
  }

  address(): AddressInfo | null {
    const address = this.server.address();
    return address && typeof address === "object" ? address : null;
  }

  start(): Promise<void> {
    if (this.draining) return Promise.reject(new Error("Control API is stopping."));
    if (!this.opening) {
      this.opening = new Promise((resolve, reject) => {
        const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
        const onListening = () => { this.server.off("error", onError); this.started = true; resolve(); };
        this.server.once("error", onError);
        this.server.once("listening", onListening);
        this.server.listen(this.config.port, this.config.host);
      });
    }
    return this.opening;
  }

  stop(): Promise<void> {
    this.draining = true;
    if (!this.closing) this.closing = this.close();
    return this.closing;
  }

  private async close(): Promise<void> {
    if (!this.opening) { this.server.removeAllListeners(); return; }
    try { await this.opening; } catch { this.server.removeAllListeners(); return; }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
    await Promise.allSettled([...this.active]);
    this.started = false;
    this.server.removeAllListeners();
  }

  forceClose(): void {
    this.draining = true;
    this.server.closeAllConnections();
  }

  private json(response: ServerResponse, status: number, data: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(data));
  }

  private authenticate(request: IncomingMessage): void {
    const headers = request.rawHeaders.filter((_, index) => index % 2 === 0);
    const count = headers.filter((header) => header.toLowerCase() === "authorization").length;
    if (count === 0) throw new ControlError("AUTH_REQUIRED", "Bearer authentication is required.");
    const match = typeof request.headers.authorization === "string" && /^Bearer ([^\s]+)$/.exec(request.headers.authorization);
    if (count !== 1 || !match || !timingSafeEqual(digest(match[1]), this.keyDigest)) {
      throw new ControlError("AUTH_INVALID", "Invalid bearer credentials.");
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const channelsMatch = /^\/v1\/guilds\/([^/]+)\/channels$/.exec(pathname);
      const known = ["/v1/health", "/v1/info", "/v1/status", "/v1/guilds", "/v1/messages"].includes(pathname) || !!channelsMatch;
      if (!known) throw new ControlError("ROUTE_NOT_FOUND", "Route not found.");
      const isPublic = pathname === "/v1/health" || pathname === "/v1/info";
      if (!isPublic) this.authenticate(request);
      const method = pathname === "/v1/messages" ? "POST" : "GET";
      if (request.method !== method) {
        response.setHeader("Allow", method);
        throw new ControlError("METHOD_NOT_ALLOWED", "Method not allowed.");
      }
      const state = this.processState();
      if (pathname === "/v1/info") { this.json(response, 200, this.info); return; }
      if (pathname === "/v1/health") {
        const { discord } = this.operations.getStatus();
        const ready = !this.draining && state === "running" && discord.ready;
        this.json(response, ready ? 200 : 503, {
          service: this.info.service, version: this.info.version, apiVersion: this.info.apiVersion,
          ready, process: { state }, discord: { state: discord.state, ready: discord.ready },
        });
        return;
      }
      if (this.draining || state === "stopping") throw new ControlError("SERVICE_UNAVAILABLE", "The process is stopping.");
      if (pathname === "/v1/status") { this.json(response, 200, this.operations.getStatus()); return; }
      if (state !== "running") throw new ControlError("SERVICE_UNAVAILABLE", "The process is starting.");
      if (pathname === "/v1/guilds") { this.json(response, 200, { guilds: await this.operations.listGuilds() }); return; }
      if (channelsMatch) {
        const guildId = channelsMatch[1];
        validateId(guildId);
        this.json(response, 200, { guildId, channels: await this.operations.listChannels(guildId) });
        return;
      }
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/i.test(request.headers["content-type"] ?? "")) {
        throw new ControlError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json with optional UTF-8 charset.");
      }
      const payload = validateMessage(await readJson(request));
      if (this.draining || this.processState() !== "running") throw new ControlError("SERVICE_UNAVAILABLE", "The process is stopping.");
      this.json(response, 201, await this.operations.sendMessage(payload.channelId, payload.content));
    } catch (error) {
      const safe = error instanceof ControlError ? error : new ControlError("INTERNAL_ERROR", "An unexpected error occurred.");
      if (safe.code === "INTERNAL_ERROR") Logger.error("Control API request failed.");
      this.json(response, errorStatuses[safe.code], { code: safe.code, message: safe.message });
    } finally { request.resume(); }
  }
}
