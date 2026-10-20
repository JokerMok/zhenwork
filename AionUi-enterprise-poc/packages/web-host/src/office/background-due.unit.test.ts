import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { enterpriseProfilePath } from '../enterprise-core.js';
import { backgroundDue } from './background-due.js';

const execute = promisify(execFile);
const roots: string[] = [];
const actor = (userId: string) => ({ serverId: 'rc2', userId });

async function fixture(userId = '17'): Promise<{ root: string; profile: string; database: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'background-due-'));
  const profile = enterpriseProfilePath(root, actor(userId));
  roots.push(root);
  await mkdir(profile, { recursive: true });
  return { root, profile, database: path.join(profile, 'aionui-backend.db') };
}

async function database(file: string, jobs: unknown[], runs: unknown[] = []): Promise<void> {
  const script = `import json,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE cron_jobs(id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, next_run_at INTEGER)')
c.execute("CREATE TABLE cron_job_runs(job_id TEXT,status TEXT,lease_until INTEGER)")
c.executemany('INSERT INTO cron_jobs VALUES(?,?,?)',json.loads(sys.argv[2]))
c.executemany('INSERT INTO cron_job_runs VALUES(?,?,?)',json.loads(sys.argv[3]))
c.commit();c.close()`;
  await execute('python3', ['-c', script, file, JSON.stringify(jobs), JSON.stringify(runs)]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('only an enabled and granted job near its next run is due', async () => {
  const { root, database: file } = await fixture();
  const now = Date.now();
  await database(file, [
    ['cron_due00001', 1, now + 60_000],
    ['cron_future001', 1, now + 600_000],
    ['cron_disabled1', 0, now],
    ['cron_ungranted1', 1, now],
  ]);
  expect(await backgroundDue(root, actor('17'), ['cron_due00001'])).toBe(true);
  expect(await backgroundDue(root, actor('17'), ['cron_future001'])).toBe(false);
  expect(await backgroundDue(root, actor('17'), ['cron_disabled1'])).toBe(false);
  expect(await backgroundDue(root, actor('17'), ['cron_missing01'])).toBe(false);
});

test('active-run wakeups are limited to granted jobs and retry horizon', async () => {
  const { root, database: file } = await fixture();
  const now = Date.now();
  await database(file, [
    ['cron_retrysoon', 1, now + 600_000],
    ['cron_retrylate', 1, now + 600_000],
    ['cron_running01', 1, now + 600_000],
  ], [
    ['cron_retrysoon', 'retrying', now + 60_000],
    ['cron_retrylate', 'retrying', now + 600_000],
    ['cron_running01', 'running', now + 600_000],
  ]);
  expect(await backgroundDue(root, actor('17'), ['cron_retrysoon'])).toBe(true);
  expect(await backgroundDue(root, actor('17'), ['cron_retrylate'])).toBe(false);
  expect(await backgroundDue(root, actor('17'), ['cron_running01'])).toBe(true);
  expect(await backgroundDue(root, actor('17'), ['cron_ungranted1'])).toBe(false);
});

test('a disabled job cannot wake a worker through a stale active row', async () => {
  const { root, database: file } = await fixture();
  const now = Date.now();
  await database(file, [['cron_disabled1', 0, now]], [['cron_disabled1', 'running', now]]);
  expect(await backgroundDue(root, actor('17'), ['cron_disabled1'])).toBe(false);
});

test('a retry row without a lease is not due and does not break inspection', async () => {
  const { root, database: file } = await fixture();
  const now = Date.now();
  await database(file, [['cron_nulllease', 1, now + 600_000]], [['cron_nulllease', 'retrying', null]]);
  expect(await backgroundDue(root, actor('17'), ['cron_nulllease'])).toBe(false);
});

test('an actor cannot inspect another actor database through a symlink', async () => {
  const { root, profile } = await fixture('17');
  const otherProfile = enterpriseProfilePath(root, actor('18'));
  const otherDatabase = path.join(otherProfile, 'aionui-backend.db');
  await mkdir(otherProfile, { recursive: true });
  await database(otherDatabase, [['cron_due00001', 1, Date.now()]]);
  await symlink(otherDatabase, path.join(profile, 'aionui-backend.db'));
  await expect(backgroundDue(root, actor('17'), ['cron_due00001'])).rejects.toThrow('BACKGROUND_DATABASE_PATH_DENIED');
});

test('no grants short-circuits without touching an absent profile or database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'background-due-empty-'));
  roots.push(root);
  expect(await backgroundDue(root, actor('17'), [])).toBe(false);
});
