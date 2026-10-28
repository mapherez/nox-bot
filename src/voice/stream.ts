import { PassThrough } from "node:stream";
import opus from "@discordjs/opus";
import WebSocket from "ws";
import { DiscordUpsampler, FRAME_BYTES } from "./audio.js";
import { VoiceError } from "./errors.js";

// Owns the engine clock independently of Discord's intermittent receive streams.
export class EngineAudio {
  readonly output = new PassThrough({ objectMode: true, highWaterMark: 12 });
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private closed = false;
  private cancel?: () => void;
  constructor(
    private readonly socket: WebSocket,
    private readonly input: () => Buffer,
    private readonly onFailure: () => void,
  ) {}
  start(): Promise<void> {
    const encoder = new opus.OpusEncoder(48000, 2),
      resampler = new DiscordUpsampler();
    encoder.setBitrate(96000);
    return new Promise((resolve, reject) => {
      this.cancel = () => reject(new VoiceError("Voice conversation closed."));
      let first = true,
        lastMessage = performance.now(),
        next = performance.now();
      const failure = () => {
        if (this.closed) return;
        reject(
          new VoiceError(
            "Engine audio disconnected or stalled. Reactivate NoX Voice when the voice service is ready and free.",
            503,
          ),
        );
        this.close();
        this.onFailure();
      };
      this.socket.on("error", failure);
      this.socket.on("close", failure);
      this.socket.on("message", (raw, binary) => {
        if (this.closed || !binary) return;
        const frame = Buffer.from(raw as Buffer);
        if (frame.length !== FRAME_BYTES) {
          failure();
          return;
        }
        lastMessage = performance.now();
        const pcm = resampler.convert(frame);
        try {
          for (let offset = 0; offset < pcm.length; offset += 3840) {
            if (this.output.writableLength + this.output.readableLength >= 12) {
              failure();
              return;
            }
            this.output.write(
              encoder.encode(pcm.subarray(offset, offset + 3840)),
            );
          }
        } catch {
          failure();
          return;
        }
        if (first) {
          first = false;
          this.cancel = undefined;
          resolve();
        }
      });
      const tick = () => {
        if (this.closed) return;
        if (
          this.socket.readyState !== WebSocket.OPEN ||
          this.socket.bufferedAmount > FRAME_BYTES * 3
        ) {
          failure();
          return;
        }
        this.socket.send(this.input(), { binary: true }, (error) => {
          if (error) failure();
        });
        next += 80;
        if (next < performance.now() - 80) next = performance.now() + 80;
        this.timer = setTimeout(tick, Math.max(0, next - performance.now()));
        this.timer.unref();
      };
      this.watchdog = setInterval(() => {
        if (performance.now() - lastMessage > 15000) failure();
      }, 1000);
      this.watchdog.unref();
      tick();
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    this.socket.close(1000);
    const timer = setTimeout(() => this.socket.terminate(), 1000);
    timer.unref();
    this.socket.once("close", () => clearTimeout(timer));
    this.output.destroy();
  }
}
