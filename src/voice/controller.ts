import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { checkServerIdentity, createSecureContext } from "node:tls";
import WebSocket from "ws";
import type { EngineStatus, VoiceSettings } from "../shared/voice.js";
import { VoiceError } from "./errors.js";

export interface Controller {
  status(): Promise<EngineStatus>;
  settings(): Promise<VoiceSettings>;
  update(settings: VoiceSettings): Promise<VoiceSettings>;
  action(action: "start" | "stop" | "restart"): Promise<EngineStatus>;
  diagnostics(): Promise<unknown>;
  connect(): Promise<WebSocket>;
}
export class VoiceController implements Controller {
  private constructor(
    private readonly url: URL,
    private readonly tls: RequestOptions,
  ) {}
  static async fromEnvironment(
    env: NodeJS.ProcessEnv,
  ): Promise<VoiceController | undefined> {
    if (!env.NOX_VOICE_CONTROLLER_URL) return undefined;
    try {
      const url = new URL(env.NOX_VOICE_CONTROLLER_URL);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error("Invalid controller URL");
      const [ca, cert, key] = await Promise.all(
        [
          "NOX_VOICE_CA_FILE",
          "NOX_VOICE_CLIENT_CERT_FILE",
          "NOX_VOICE_CLIENT_KEY_FILE",
        ].map((name) => {
          if (!env[name]) throw new Error("Missing credential file");
          return readFile(env[name]!);
        }),
      );
      createSecureContext({ ca, cert, key });
      return new VoiceController(url, {
        ca,
        cert,
        key,
        rejectUnauthorized: true,
        // ws and https verify the configured controller identity, including IP SANs.
        checkServerIdentity,
      });
    } catch {
      throw new VoiceError(
        "NoX Voice configuration is invalid. Check the HTTPS controller URL and the three readable client certificate files.",
        503,
      );
    }
  }
  private json<T>(path: string, method = "GET", payload?: unknown): Promise<T> {
    const data =
      payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const fail = () =>
        reject(
          new VoiceError(
            "Cannot reach the nox-voice-mlx controller. Check its address, network access and client certificates.",
            503,
          ),
        );
      const request = httpsRequest(
        new URL(path, this.url),
        {
          ...this.tls,
          method,
          headers: data
            ? {
                "Content-Type": "application/json",
                "Content-Length": data.length,
              }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > 131072) {
              response.destroy();
              fail();
            } else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            if ((response.statusCode ?? 500) >= 300) {
              reject(
                new VoiceError(
                  response.statusCode === 409
                    ? "The engine is busy. End the other conversation or wait for the current operation."
                    : "The controller rejected the operation. Check the engine status.",
                  response.statusCode === 409 ? 409 : 503,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
            } catch {
              fail();
            }
          });
        },
      );
      const timeout = setTimeout(
        () => request.destroy(),
        method === "PUT" ? 190000 : 10000,
      );
      timeout.unref();
      request.once("close", () => clearTimeout(timeout));
      request.on("error", fail);
      request.end(data);
    });
  }
  status() {
    return this.json<EngineStatus>("/api/engine/status");
  }
  settings() {
    return this.json<VoiceSettings>("/api/settings");
  }
  update(settings: VoiceSettings) {
    return this.json<VoiceSettings>("/api/settings", "PUT", settings);
  }
  action(action: "start" | "stop" | "restart") {
    return this.json<EngineStatus>(`/api/engine/${action}`, "POST");
  }
  diagnostics() {
    return this.json<unknown>("/api/diagnostics");
  }
  connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = new URL("/ws", this.url);
      url.protocol = "wss:";
      const socket = new WebSocket(url, {
        ...this.tls,
        followRedirects: false,
        handshakeTimeout: 10000,
        maxPayload: 65536,
        perMessageDeflate: false,
      });
      socket.once("error", () =>
        reject(
          new VoiceError(
            "Could not open the engine audio connection. Check the controller and client certificates.",
            503,
          ),
        ),
      );
      socket.once("open", () => resolve(socket));
    });
  }
}
