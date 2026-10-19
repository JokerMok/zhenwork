import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { startEnterpriseGateway } from './enterprise-gateway.js';

test('scheduled Core stays alive after logout and stops after its job is deleted', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'background-gateway-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html><head></head><body></body></html>');
  let started = 0;
  let stopped = 0;
  let granted = false;
  let core: http.Server | undefined;
  const gateway = await startEnterpriseGateway({ staticDir, publicOrigin: 'https://workspace.example', port: 0,
    login: async () => ({ actor: { serverId: 'rc2', userId: '17' }, validate: async () => true,
      close: async () => {} }),
    syncCronGrant: async (_actor, jobId, enabled) => {
      expect(jobId).toBe('cron_1234567890');
      granted = enabled;
    },
    hasBackgroundJobs: () => granted,
    startCore: async () => {
      started++;
      core = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && req.url === '/api/cron/jobs') {
          res.statusCode = 201;
          res.end(JSON.stringify({ success: true, data: { id: 'cron_1234567890', enabled: true } }));
        } else if (req.method === 'DELETE' && req.url === '/api/cron/jobs/cron_1234567890') {
          res.end(JSON.stringify({ success: true }));
        } else res.end(JSON.stringify({ success: true }));
      });
      await new Promise<void>((resolve) => core!.listen(0, '127.0.0.1', resolve));
      return { port: (core.address() as { port: number }).port, localToken: 'private-core-token',
        stop: async () => { stopped++; await new Promise<void>((resolve) => core!.close(() => resolve())); } };
    },
  });
  const request = (method: string, route: string, cookie?: string, body?: object) =>
    new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, method, path: route,
        headers: { host: 'workspace.example', origin: 'https://workspace.example',
          ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode || 0,
        cookie: res.headers['set-cookie']?.[0]?.split(';')[0] })); });
      req.once('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  try {
    const first = await request('POST', '/enterprise/login', undefined,
      { username: 'employee', password: 'test' });
    expect(first.status).toBe(200);
    expect((await request('POST', '/api/cron/jobs', first.cookie, { name: 'Daily' })).status).toBe(201);
    expect(granted).toBe(true);
    expect((await request('POST', '/enterprise/logout', first.cookie)).status).toBe(200);
    expect(stopped).toBe(0);
    const second = await request('POST', '/enterprise/login', undefined,
      { username: 'employee', password: 'test' });
    expect((await request('DELETE', '/api/cron/jobs/cron_1234567890', second.cookie)).status).toBe(200);
    expect(granted).toBe(false);
    expect((await request('POST', '/enterprise/logout', second.cookie)).status).toBe(200);
    expect(started).toBe(1);
    expect(stopped).toBe(1);
  } finally {
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});

test('revoked background authorization stops Core while preserving a valid employee session', async () => {
  const staticDir = await mkdtemp(path.join(tmpdir(), 'background-revoked-'));
  await writeFile(path.join(staticDir, 'index.html'), '<html></html>');
  const actor = { serverId: 'rc2', userId: '17' };
  let authorized = true;
  let stopped = 0;
  let started = 0;
  const core = http.createServer((_req, res) => res.end('{}'));
  const gateway = await startEnterpriseGateway({ staticDir, publicOrigin: 'https://workspace.example', port: 0,
    login: async () => ({ actor, validate: async () => true, close: async () => {} }),
    hasBackgroundJobs: () => true,
    authorizeBackground: async () => authorized,
    startCore: async () => {
      started++;
      await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', resolve));
      return { port: (core.address() as { port: number }).port, localToken: 'private-core-token',
        stop: async () => { stopped++; await new Promise<void>((resolve) => core.close(() => resolve())); } };
    },
  });
  try {
    await gateway.startBackgroundCore(actor);
    expect(stopped).toBe(0);
    const login = await new Promise<{ status: number; cookie?: string }>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, method: 'POST',
        path: '/enterprise/login', headers: { host: 'workspace.example', origin: 'https://workspace.example',
          'content-type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode || 0,
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }));
      });
      req.once('error', reject);
      req.end(JSON.stringify({ username: 'employee', password: 'test' }));
    });
    expect(login.status).toBe(200);
    authorized = false;
    await gateway.reconcileAuthorization();
    expect(stopped).toBe(1);
    const stale = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: gateway.port, method: 'GET',
        path: '/api/system/info', headers: { host: 'workspace.example', cookie: login.cookie || '' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
      req.once('error', reject);
      req.end();
    });
    expect(stale).toBe(200);
    expect(started).toBe(2);
    await expect(gateway.startBackgroundCore(actor)).rejects.toThrow('authorization unavailable');
  } finally {
    await gateway.stop();
    await rm(staticDir, { recursive: true, force: true });
  }
});
