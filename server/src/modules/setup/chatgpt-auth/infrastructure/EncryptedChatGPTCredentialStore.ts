import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAppDataRoot } from "../../../../runtime/appPaths";
import type { ChatGPTCredentialProfile } from "../domain/types";

interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedChatGPTCredentialStore {
  private readonly directory: string;
  private readonly credentialPath: string;
  private readonly keyPath: string;
  private readonly hostPath: string;

  constructor(options: { directory?: string } = {}) {
    this.directory = options.directory ?? path.join(resolveAppDataRoot(), "secrets");
    this.credentialPath = path.join(this.directory, "chatgpt-credentials.enc.json");
    this.keyPath = path.join(this.directory, "chatgpt-credentials.key");
    this.hostPath = path.join(this.directory, "chatgpt-host.json");
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    await this.ensureDirectory();
    try {
      const key = await fs.readFile(this.keyPath);
      if (key.length !== 32) throw new Error("ChatGPT credential key is invalid.");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = crypto.randomBytes(32);
      await fs.writeFile(this.keyPath, key, { flag: "wx", mode: 0o600 });
      return key;
    }
  }

  async load(): Promise<ChatGPTCredentialProfile | null> {
    try {
      const [key, raw] = await Promise.all([
        this.loadOrCreateKey(),
        fs.readFile(this.credentialPath, "utf8"),
      ]);
      const payload = JSON.parse(raw) as EncryptedPayload;
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64url"),
      );
      decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as ChatGPTCredentialProfile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(profile: ChatGPTCredentialProfile): Promise<void> {
    const key = await this.loadOrCreateKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(profile), "utf8"),
      cipher.final(),
    ]);
    const payload: EncryptedPayload = {
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
    await this.ensureDirectory();
    const temporaryPath = `${this.credentialPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(payload), { mode: 0o600 });
    await fs.rename(temporaryPath, this.credentialPath);
  }

  async clear(): Promise<void> {
    await fs.rm(this.credentialPath, { force: true });
  }

  async loadOrCreateHostId(): Promise<string> {
    await this.ensureDirectory();
    try {
      const payload = JSON.parse(await fs.readFile(this.hostPath, "utf8")) as { hostId?: unknown };
      if (typeof payload.hostId === "string" && payload.hostId.startsWith("urn:uuid:")) {
        return payload.hostId;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const hostId = `urn:uuid:${crypto.randomUUID()}`;
    await fs.writeFile(this.hostPath, JSON.stringify({ hostId }), { flag: "wx", mode: 0o600 });
    return hostId;
  }
}

export const chatGPTCredentialStore = new EncryptedChatGPTCredentialStore();
