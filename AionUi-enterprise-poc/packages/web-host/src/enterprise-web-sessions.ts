import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const WEB_SESSION_SECONDS = 30 * 24 * 60 * 60;

type StoredSession = { credential: string; username?: string; expiresAt: number };

/** Encrypted, host-only RC2 credentials indexed by a digest of the opaque browser cookie. */
export class EnterpriseWebSessions {
  private constructor(
    private readonly directory: string,
    private readonly key: Buffer
  ) {}

  static async open(profileRoot: string, serviceToken: string): Promise<EnterpriseWebSessions> {
    const directory = path.join(profileRoot, '.web-sessions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.mode & 0o077 || (process.getuid && entry.uid !== process.getuid())) {
      throw new Error('Web session directory must be private and owned by the host');
    }
    const key = Buffer.from(hkdfSync('sha256', serviceToken, '', 'zhenwork-web-sessions-v1', 32));
    const store = new EnterpriseWebSessions(directory, key);
    await store.pruneExpired();
    return store;
  }

  private file(id: string): string {
    return path.join(this.directory, createHash('sha256').update(id).digest('hex'));
  }

  async put(id: string, session: StoredSession): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
    await writeFile(this.file(id), Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const file = this.file(id);
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException): undefined => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!entry?.isFile() || entry.mode & 0o077 || entry.size > 8192) return undefined;
    const encrypted = await readFile(file);
    const cipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(encrypted.subarray(12, 28));
    const session: StoredSession = JSON.parse(
      Buffer.concat([cipher.update(encrypted.subarray(28)), cipher.final()]).toString('utf8')
    );
    if (session.expiresAt <= Date.now()) {
      await this.remove(id);
      return undefined;
    }
    return session;
  }

  async remove(id: string): Promise<void> {
    await rm(this.file(id), { force: true });
  }

  async pruneExpired(): Promise<void> {
    const cutoff = Date.now() - WEB_SESSION_SECONDS * 1000;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name);
      const attrs = await lstat(file).catch((error: NodeJS.ErrnoException): undefined => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (attrs && attrs.mtimeMs <= cutoff) await rm(file, { force: true });
    }
  }
}
