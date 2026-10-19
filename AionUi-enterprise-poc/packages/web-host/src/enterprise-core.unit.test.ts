import { mkdtemp, mkdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, expect } from 'vitest';
import { createEnterpriseCoreStarter, enterpriseProfilePath } from './enterprise-core.js';

test('rejects a linked actor directory before touching its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enterprise-core-dir-'));
  const target = await mkdtemp(path.join(tmpdir(), 'enterprise-core-target-'));
  try {
    const launcher = path.join(root, 'launcher');
    await writeFile(launcher, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const actor = { serverId: 'rc2', userId: '1' };
    const profile = enterpriseProfilePath(root, actor);
    await mkdir(path.dirname(profile), { recursive: true });
    await symlink(target, profile);
    const before = (await stat(target)).mode & 0o777;
    const start = createEnterpriseCoreStarter({ profileRoot: root, isolatedLauncher: launcher,
      appVersion: '2.2.2', resourcesPath: root });
    await expect(start(actor)).rejects.toThrow('symlink');
    expect((await stat(target)).mode & 0o777).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
