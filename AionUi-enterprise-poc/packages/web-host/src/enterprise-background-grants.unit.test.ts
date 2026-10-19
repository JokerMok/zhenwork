import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { EnterpriseBackgroundGrants } from './enterprise-background-grants.js';
import { verifyBackgroundService } from './enterprise-background-client.js';
import { enterpriseManagedResourcePath } from './enterprise-resource-runtime.js';

test('a host-only grant survives a store reload and is removed on job deletion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-grants-'));
  const actor = { serverId: 'rc2', userId: '17' };
  const jobId = 'cron_1234567890';
  const grantId = '11111111-1111-4111-8111-111111111111';
  const secret = 'b'.repeat(64);
  let revoked = false;
  let unavailable = false;
  let revokeUnavailable = false;
  const rc2 = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (unavailable) { res.statusCode = 503; res.end(JSON.stringify({ code: 503 })); return; }
    if (req.url === '/internal/rc2/background/health') {
      const allowed = req.headers.authorization === `Bearer ${'a'.repeat(43)}`;
      res.statusCode = allowed ? 200 : 401;
      res.end(JSON.stringify(allowed ? { code: 200, data: { ready: true } } : { code: 401 }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${'a'.repeat(43)}` ||
        req.headers['x-aion-background-secret'] !== secret || revoked) {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: 401 }));
      return;
    }
    const data = req.url?.endsWith('/models/available')
      ? [{ id: 'model-1', code: 'pilot', name: 'Pilot', streaming: true }]
      : { userId: '17', jobId };
    res.end(JSON.stringify({ code: 200, data }));
  });
  await new Promise<void>((resolve) => rc2.listen(0, '127.0.0.1', resolve));
  const port = (rc2.address() as { port: number }).port;
  const issuer = { request: async (_route: string, options: RequestInit) => {
    if (options.method === 'DELETE' && revokeUnavailable) {
      return { response: new Response(null, { status: 503 }), body: { code: 503 } };
    }
    if (options.method === 'DELETE') revoked = true;
    return { response: new Response(null, { status: 200 }),
      body: { code: 200, data: { id: grantId, jobId, secret } } };
  } } as never;
  try {
    const store = new EnterpriseBackgroundGrants(root, actor,
      `http://127.0.0.1:${port}`, 'a'.repeat(43));
    await verifyBackgroundService(`http://127.0.0.1:${port}`, 'a'.repeat(43));
    await expect(verifyBackgroundService(`http://127.0.0.1:${port}`, 'x'.repeat(43)))
      .rejects.toThrow('background service unavailable');
    await store.load();
    await store.issue(issuer, jobId);
    expect(store.hasJobs()).toBe(true);
    expect(await EnterpriseBackgroundGrants.discoverActors(root,
      `http://127.0.0.1:${port}`, 'a'.repeat(43))).toEqual([actor]);
    unavailable = true;
    await expect(EnterpriseBackgroundGrants.discoverActors(root,
      `http://127.0.0.1:${port}`, 'a'.repeat(43))).rejects.toThrow('Background RC2 unavailable');
    unavailable = false;
    revoked = true;
    expect(await EnterpriseBackgroundGrants.discoverActors(root,
      `http://127.0.0.1:${port}`, 'a'.repeat(43))).toEqual([]);
    revoked = false;
    expect(await (await store.client()).availableModels()).toEqual([
      { id: 'model-1', code: 'pilot', name: 'Pilot', streaming: true },
    ]);
    expect((await (await store.clientFor(jobId)).me()).userId).toBe('17');
    await expect(store.clientFor('cron_unrelated123')).rejects.toThrow('Background grant revoked');
    const restored = new EnterpriseBackgroundGrants(root, actor,
      `http://127.0.0.1:${port}`, 'a'.repeat(43));
    await restored.load();
    expect((await (await restored.client()).me()).userId).toBe('17');
    expect(await restored.inspect()).toEqual({ valid: [jobId], revoked: [] });
    revoked = true;
    expect(await restored.inspect()).toEqual({ valid: [], revoked: [{ jobId, grantId }] });
    await expect(restored.disableRevoked(jobId, grantId, async () => {
      throw new Error('Core unavailable');
    })).rejects.toThrow('Core unavailable');
    expect(restored.hasJobs()).toBe(true);
    revoked = false;
    revokeUnavailable = true;
    await expect(restored.revoke(issuer, jobId)).rejects.toThrow('revocation unavailable');
    expect(restored.hasJobs()).toBe(true);
    expect((await (await restored.client()).me()).userId).toBe('17');
    revokeUnavailable = false;
    await restored.revoke(issuer, jobId);
    expect(restored.hasJobs()).toBe(false);
    await expect(restored.clientFor(jobId)).rejects.toThrow('Background grant revoked');
    const file = path.join(path.dirname(await enterpriseManagedResourcePath(root, actor)),
      'background-grants.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ actor, grants: [] });
    await expect(store.client()).rejects.toThrow('Background grant revoked');
  } finally {
    await new Promise<void>((resolve) => rc2.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
