import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { registerSecret } from "../utils/logger.js";

export class SecretVault {
  private readonly key: Buffer;
  constructor(masterKey: string) {
    this.key = Buffer.from(masterKey, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== masterKey)
      throw new Error(
        "NOX_BOT_ENCRYPTION_KEY must be a canonical base64 encoded 32-byte key.",
      );
    registerSecret(masterKey);
  }
  encrypt(
    value: string,
    guildId: string,
    pluginId: string,
    field: string,
  ): string {
    registerSecret(value);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([guildId, pluginId, field])));
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "aes256gcm",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      bytes.toString("base64"),
    ].join(".");
  }
  decrypt(
    envelope: string,
    guildId: string,
    pluginId: string,
    field: string,
  ): string {
    const [algorithm, nonce, tag, bytes, extra] = envelope.split(".");
    if (algorithm !== "aes256gcm" || !nonce || !tag || !bytes || extra)
      throw new Error("Invalid encrypted plugin secret.");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(JSON.stringify([guildId, pluginId, field])));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const value = Buffer.concat([
      decipher.update(Buffer.from(bytes, "base64")),
      decipher.final(),
    ]).toString("utf8");
    registerSecret(value);
    return value;
  }
}
