import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnterpriseActor } from './enterprise-gateway.js';
import { BackgroundGrantRevokedError, EnterpriseBackgroundClient, type BackgroundGrant } from './enterprise-background-client.js';
import { enterpriseManagedResourcePath } from './enterprise-resource-runtime.js';
import type { Rc2GatewayClient } from './enterprise-rc2-login.mjs';

type GrantIssuer = Rc2GatewayClient & {
  request(path: string, options?: RequestInit): Promise<{ response: Response; body: { code?: number; data?: unknown } | null }>;
};

function validJobId(jobId: string): boolean {
  return /^cron_[A-Za-z0-9_-]{8,80}$/.test(jobId);
}

/** The file is in the host-only control tree, outside Core's mounted workspace. */
export class EnterpriseBackgroundGrants {
  private readonly grants = new Map<string, BackgroundGrant>();
  private file = '';
  private sequence: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly actor: EnterpriseActor,
    private readonly rc2Url: string, private readonly serviceToken: string) {}

  static async discoverActors(root: string, rc2Url: string, serviceToken: string): Promise<EnterpriseActor[]> {
    const control = path.join(root, 'control');
    const servers = await readdir(control, { withFileTypes: true }).catch((error: NodeJS.ErrnoException): Dirent[] => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (servers.length > 100) throw new Error('Background actor catalog too large');
    const actors: EnterpriseActor[] = [];
    for (const server of servers) {
      if (!server.isDirectory() || server.isSymbolicLink()) throw new Error('Background control directory invalid');
      const users = await readdir(path.join(control, server.name), { withFileTypes: true });
      if (users.length > 100) throw new Error('Background actor catalog too large');
      for (const user of users) {
        if (!user.isDirectory() || user.isSymbolicLink()) throw new Error('Background control directory invalid');
        const file = path.join(control, server.name, user.name, 'background-grants.json');
        const entry = await lstat(file).catch((error: NodeJS.ErrnoException): null => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!entry) continue;
        if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 100_000)
          throw new Error('Background grant file is not private');
        const saved = JSON.parse(await readFile(file, 'utf8')) as { actor?: EnterpriseActor; grants?: unknown };
        if (!saved.actor || !Array.isArray(saved.grants) || saved.grants.length === 0) continue;
        const store = new EnterpriseBackgroundGrants(root, saved.actor, rc2Url, serviceToken);
        await store.load();
        if (store.file !== file) throw new Error('Background grant actor path mismatch');
        try { await store.client(); actors.push(saved.actor); }
        catch (error) {
          if (!(error instanceof BackgroundGrantRevokedError)) throw error;
          // A revoked or disabled account cannot resume scheduled work.
        }
      }
    }
    return actors;
  }

  async load(): Promise<void> {
    this.file = path.join(path.dirname(await enterpriseManagedResourcePath(this.root, this.actor)),
      'background-grants.json');
    const entry = await lstat(this.file).catch((error: NodeJS.ErrnoException): null => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!entry) return;
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > 100_000)
      throw new Error('Background grant file is not private');
    const saved = JSON.parse(await readFile(this.file, 'utf8')) as { actor?: EnterpriseActor; grants?: unknown };
    if (saved.actor?.serverId !== this.actor.serverId || saved.actor.userId !== this.actor.userId ||
        !Array.isArray(saved.grants) || saved.grants.length > 100) throw new Error('Background grant store invalid');
    for (const value of saved.grants) {
      if (!value || typeof value !== 'object') throw new Error('Background grant store invalid');
      const grant = value as BackgroundGrant;
      if (grant.userId !== this.actor.userId || this.grants.has(grant.jobId))
        throw new Error('Background grant store actor mismatch');
      new EnterpriseBackgroundClient(this.rc2Url, this.serviceToken, grant);
      this.grants.set(grant.jobId, grant);
    }
  }

  private async persist(): Promise<void> {
    if (!this.file) throw new Error('Background grant store not loaded');
    const prior = await lstat(this.file).catch((error: NodeJS.ErrnoException): null => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (prior && (!prior.isFile() || prior.isSymbolicLink() || (prior.mode & 0o077) !== 0))
      throw new Error('Background grant file is not private');
    const temporary = `${this.file}.${randomBytes(12).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ actor: this.actor, grants: [...this.grants.values()] }),
        { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
  }

  hasJobs(): boolean { return this.grants.size > 0; }
  jobIds(): string[] { return [...this.grants.keys()]; }

  /** Check every job separately; one valid grant must not keep revoked jobs active. */
  async inspect(): Promise<{ valid: string[]; revoked: Array<{ jobId: string; grantId: string }> }> {
    const valid: string[] = [];
    const revoked: Array<{ jobId: string; grantId: string }> = [];
    const signal = AbortSignal.timeout(15_000);
    for (const grant of [...this.grants.values()]) {
      try {
        const client = new EnterpriseBackgroundClient(this.rc2Url, this.serviceToken, grant);
        if ((await client.me(signal)).userId !== this.actor.userId) throw new Error('Background grant actor mismatch');
        valid.push(grant.jobId);
      } catch (error) {
        if (!(error instanceof BackgroundGrantRevokedError)) throw error;
        revoked.push({ jobId: grant.jobId, grantId: grant.id });
      }
    }
    return { valid, revoked };
  }

  /** Serialize Core disablement with local issue/revoke operations for this store. */
  async disableRevoked(jobId: string, grantId: string, disable: () => Promise<void>): Promise<void> {
    return this.serialized(async () => {
      if (this.grants.get(jobId)?.id !== grantId) return;
      const prior = this.grants.get(jobId)!;
      await disable();
      this.grants.delete(jobId);
      try { await this.persist(); }
      catch (error) { this.grants.set(jobId, prior); throw error; }
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sequence.then(operation);
    this.sequence = result.then(() => {}, () => {});
    return result;
  }

  async client(): Promise<EnterpriseBackgroundClient> {
    let revoked = false;
    for (const grant of this.grants.values()) {
      const client = new EnterpriseBackgroundClient(this.rc2Url, this.serviceToken, grant);
      try {
        if ((await client.me()).userId === this.actor.userId) return client;
      } catch (error) {
        if (!(error instanceof BackgroundGrantRevokedError)) throw error;
        revoked = true;
      }
    }
    if (revoked) throw new BackgroundGrantRevokedError();
    throw new Error('No active background grant for employee');
  }

  async clientFor(jobId: string): Promise<EnterpriseBackgroundClient> {
    if (!validJobId(jobId)) throw new Error('Invalid background job ID');
    const grant = this.grants.get(jobId);
    if (!grant) throw new BackgroundGrantRevokedError();
    const client = new EnterpriseBackgroundClient(this.rc2Url, this.serviceToken, grant);
    if ((await client.me()).userId !== this.actor.userId) throw new BackgroundGrantRevokedError();
    return client;
  }

  async issue(issuer: GrantIssuer, jobId: string): Promise<void> {
    return this.serialized(async () => {
    if (!validJobId(jobId)) throw new Error('Invalid background job ID');
    if (this.grants.has(jobId)) throw new Error('Background grant already stored');
    const { response, body } = await issuer.request(`/ai/background/jobs/${jobId}/grant`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.serviceToken}` },
    });
    const data = body?.data as { id?: string; jobId?: string; secret?: string } | undefined;
    if (!response.ok || body?.code !== 200 || !data || data.jobId !== jobId ||
        typeof data.id !== 'string' || typeof data.secret !== 'string')
      throw new Error('RC2 background grant denied');
    const grant = { id: data.id, jobId, secret: data.secret, userId: this.actor.userId };
    new EnterpriseBackgroundClient(this.rc2Url, this.serviceToken, grant);
    this.grants.set(jobId, grant);
    try { await this.persist(); }
    catch (error) {
      this.grants.delete(jobId);
      await issuer.request(`/ai/background/jobs/${jobId}/grant`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${this.serviceToken}` },
      }).catch(() => {});
      throw error;
    }
    });
  }

  async revoke(issuer: GrantIssuer, jobId: string): Promise<void> {
    return this.serialized(async () => {
    if (!validJobId(jobId)) throw new Error('Invalid background job ID');
    const { response, body } = await issuer.request(`/ai/background/jobs/${jobId}/grant`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.serviceToken}` },
    });
    if (!response.ok || body?.code !== 200) throw new Error('RC2 background grant revocation unavailable');
    const prior = this.grants.get(jobId);
    this.grants.delete(jobId);
    try { await this.persist(); }
    catch (error) { if (prior) this.grants.set(jobId, prior); throw error; }
    });
  }
}
