// Discord: 48 kHz stereo s16le. nox-voice-mlx: 24 kHz mono Float32LE, 80 ms.
export const FRAME_SAMPLES = 1920;
export const FRAME_BYTES = FRAME_SAMPLES * 4;
const MAX_SAMPLES = FRAME_SAMPLES * 3;
// Windowed sinc low-pass filter before decimation; retain filter state between Opus packets.
const TAPS = 31;
const coefficients = Array.from({ length: TAPS }, (_, i) => {
  const x = i - (TAPS - 1) / 2,
    cutoff = 0.225;
  return (
    (x === 0
      ? 2 * cutoff
      : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)) *
    (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)))
  );
});
const sum = coefficients.reduce((a, b) => a + b, 0);
for (let i = 0; i < coefficients.length; i++) coefficients[i] /= sum;
export class DiscordDownsampler {
  private history = new Float32Array(TAPS);
  private position = 0;
  private phase = 0;
  convert(pcm: Buffer): Float32Array {
    if (pcm.length % 4) throw new Error("Invalid stereo PCM");
    const output: number[] = [];
    for (let i = 0; i < pcm.length; i += 4) {
      this.history[this.position] =
        (pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 65536;
      this.position = (this.position + 1) % TAPS;
      if (this.phase++ % 2) continue;
      let value = 0;
      for (let j = 0; j < TAPS; j++)
        value += this.history[(this.position + j) % TAPS] * coefficients[j];
      output.push(value);
    }
    return Float32Array.from(output);
  }
}
interface Speaker {
  samples: number[];
  lastPacket: number;
}
export class InputMixer {
  private speakers = new Map<string, Speaker>();
  push(id: string, samples: Float32Array, now = performance.now()): void {
    let speaker = this.speakers.get(id);
    // Discard the tail of an old utterance instead of playing it after a pause.
    if (!speaker || now - speaker.lastPacket > 160)
      speaker = { samples: [], lastPacket: now };
    speaker.lastPacket = now;
    for (const sample of samples)
      speaker.samples.push(Number.isFinite(sample) ? sample : 0);
    if (speaker.samples.length > MAX_SAMPLES)
      speaker.samples.splice(0, speaker.samples.length - MAX_SAMPLES);
    this.speakers.set(id, speaker);
  }
  remove(id: string): void {
    this.speakers.delete(id);
  }
  frame(now = performance.now()): Buffer {
    const mix = new Float32Array(FRAME_SAMPLES);
    for (const [id, speaker] of this.speakers) {
      if (now - speaker.lastPacket > 240) {
        this.speakers.delete(id);
        continue;
      }
      const samples = speaker.samples.splice(0, FRAME_SAMPLES);
      for (let i = 0; i < samples.length; i++) mix[i] += samples[i];
      if (!samples.length) this.speakers.delete(id);
    }
    const output = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++)
      output.writeFloatLE(Math.max(-1, Math.min(1, mix[i])), i * 4);
    return output;
  }
}
export class DiscordUpsampler {
  private previous = 0;
  convert(frame: Buffer): Buffer {
    if (frame.length !== FRAME_BYTES) throw new Error("Invalid engine frame");
    const output = Buffer.alloc(FRAME_SAMPLES * 8);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const raw = frame.readFloatLE(i * 4);
      const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      const a = Math.round(((this.previous + value) / 2) * 32767),
        b = Math.round(value * 32767);
      output.writeInt16LE(a, i * 8);
      output.writeInt16LE(a, i * 8 + 2);
      output.writeInt16LE(b, i * 8 + 4);
      output.writeInt16LE(b, i * 8 + 6);
      this.previous = value;
    }
    return output;
  }
}
