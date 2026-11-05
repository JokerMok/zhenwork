import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { startEnterpriseGateway, type EnterpriseActor } from '../enterprise-gateway.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'employee-preferences-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.html'), '<html></html>');
  const names = new Map([
    ['1', 'Employee One'],
    ['2', 'Employee Two'],
  ]);
  const controlRequest = vi.fn(async (actor: EnterpriseActor, _route: string, init: RequestInit) => {
    if (init.method === 'PUT') {
      names.set(actor.userId, (JSON.parse(String(init.body)) as { nickName: string }).nickName);
      return Response.json({ code: 200 });
    }
    return Response.json({
      code: 200,
      data: {
        user: {
          userId: actor.userId,
          userName: 'employee-' + actor.userId,
          nickName: names.get(actor.userId),
          deptName: 'Operations',
          avatarUrl: 'javascript:alert(1)',
          email: 'not-for-workspace@example.test',
        },
        postGroup: 'Analyst',
        roleGroup: 'Unrelated role',
      },
    });
  });
  const changePassword = vi.fn(async () => {});
  const startCore = vi.fn(async () => {
    throw new Error('Personal settings must remain available with cold Core');
  });
  const gateway = await startEnterpriseGateway({
    staticDir: root,
    profileRoot: root,
    publicOrigin: 'http://127.0.0.1',
    port: 0,
    allowInsecureLoopbackDev: true,
    login: async (userId) => ({
      actor: { serverId: 'rc2', userId },
      validate: async () => true,
      close: async () => {},
    }),
    startCore,
    controlRequest,
    changePassword,
  });
  cleanups.push(gateway.stop);
  const call = (route: string, method = 'GET', cookie = '', value?: unknown, origin = 'http://127.0.0.1') =>
    new Promise<Response>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: gateway.port,
          path: route,
          method,
          headers: { host: '127.0.0.1', origin, cookie, 'content-type': 'application/json' },
        },
        async (res) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of res) chunks.push(chunk as Buffer);
            resolve(
              new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers as HeadersInit })
            );
          } catch (error) {
            reject(error);
          }
        }
      );
      req.on('error', reject);
      req.end(value === undefined ? undefined : JSON.stringify(value));
    });
  const login = async (username: string) => {
    const response = await call('/enterprise/login', 'POST', '', { username, password: 'fixture-only' });
    expect(response.status).toBe(200);
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  return { root, call, login, changePassword, controlRequest, startCore };
}

test('the employee profile uses the authenticated RC2 subject and accepts only the nickname', async () => {
  const f = await fixture();
  const one = await f.login('1');
  expect((await f.call('/enterprise/self-profile')).status).toBe(401);
  expect((await f.call('/enterprise/self-profile?userId=2', 'GET', one)).status).toBe(404);
  expect((await f.call('/enterprise/control/system/user/profile', 'GET', one)).status).toBe(404);
  expect((await f.call('/enterprise/self-profile', 'DELETE', one)).status).toBe(405);
  expect((await f.call('/enterprise/self-profile', 'PUT', one, { nickname: 'Changed', userId: '2' })).status).toBe(400);
  expect(f.controlRequest).not.toHaveBeenCalled();

  const saved = await f.call('/enterprise/self-profile', 'PUT', one, { nickname: ' Changed ' });
  expect(await saved.json()).toEqual({
    id: '1',
    username: 'employee-1',
    nickname: 'Changed',
    department: 'Operations',
    position: 'Analyst',
  });
  expect(
    f.controlRequest.mock.calls.map(([actor, route, init]) => [actor.userId, route, init.method, init.body])
  ).toEqual([
    ['1', '/system/user/profile', 'PUT', '{"nickName":"Changed"}'],
    ['1', '/system/user/profile', 'GET', undefined],
  ]);
  const two = await f.login('2');
  expect(await (await f.call('/enterprise/self-profile', 'GET', two)).json()).toMatchObject({
    nickname: 'Employee Two',
  });
  expect(f.startCore).not.toHaveBeenCalled();
});

test('preferences save once under competing versions and stay isolated across employee logins', async () => {
  const f = await fixture();
  const one = await f.login('1');
  const first = await f.call('/enterprise/preferences', 'GET', one);
  expect(await first.json()).toEqual({
    version: 0,
    enabled: false,
    style: '',
    detail: '',
    language: '',
    instructions: '',
  });
  const write = {
    expectedVersion: 0,
    enabled: true,
    style: 'direct',
    detail: 'brief',
    language: 'zh-CN',
    instructions: 'Example',
  };
  expect(
    (await f.call('/enterprise/preferences', 'PUT', one, { ...write, instructions: 'a'.repeat(2001) })).status
  ).toBe(400);
  expect((await f.call('/enterprise/preferences', 'PUT', one, { ...write, userId: '2' })).status).toBe(400);
  expect((await f.call('/enterprise/preferences', 'PUT', one, write, 'https://foreign.example')).status).toBe(403);
  const results = await Promise.all([
    f.call('/enterprise/preferences', 'PUT', one, write),
    f.call('/enterprise/preferences', 'PUT', one, write),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(await results.find((r) => r.status === 409)!.json()).toEqual({ error: 'PREFS_VERSION_CONFLICT' });
  await f.call('/enterprise/logout', 'POST', one);
  const other = await f.login('2');
  expect(await (await f.call('/enterprise/preferences', 'GET', other)).json()).toMatchObject({
    version: 0,
    instructions: '',
  });
  const relogin = await f.login('1');
  expect(await (await f.call('/enterprise/preferences', 'GET', relogin)).json()).toMatchObject({
    version: 1,
    instructions: 'Example',
  });
  expect(f.startCore).not.toHaveBeenCalled();
});

test('self-service password change binds reauthentication to the current actor and revokes its browser session', async () => {
  const f = await fixture();
  const one = await f.login('1');
  const input = { oldPassword: 'fixture-only', newPassword: 'Fixture123' };
  expect((await f.call('/enterprise/self-password', 'POST', one, { ...input, username: 'employee-2' })).status).toBe(
    400
  );
  expect(f.changePassword).not.toHaveBeenCalled();
  const response = await f.call('/enterprise/self-password', 'POST', one, input);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  expect(f.changePassword).toHaveBeenCalledWith('employee-1', 'fixture-only', 'Fixture123', expect.anything(), {
    serverId: 'rc2',
    userId: '1',
  });
  expect((await f.call('/enterprise/preferences', 'GET', one)).status).toBe(401);
});
