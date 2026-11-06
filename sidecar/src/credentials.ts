import { promises as fs } from "node:fs";
import path from "node:path";

export type Credentials = {
  username: string;
  password: string;
  country?: string;
  language?: string;
  trustedDeviceName?: string;
};

export const CREDENTIALS_FILE = "credentials.json";

export class CredentialStore {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, CREDENTIALS_FILE);
  }

  async load(): Promise<Credentials | null> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Credentials>;
      if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
      return {
        username: parsed.username,
        password: parsed.password,
        country: typeof parsed.country === "string" ? parsed.country : undefined,
        language: typeof parsed.language === "string" ? parsed.language : undefined,
        trustedDeviceName:
          typeof parsed.trustedDeviceName === "string" ? parsed.trustedDeviceName : undefined,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(creds: Credentials): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, this.file);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}
