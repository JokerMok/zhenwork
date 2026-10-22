import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { removeManagedSkillCache } from './enterprise-skill-cleanup.js';
test('rejects non-managed traversal names before any cleanup', async () => {
  await expect(removeManagedSkillCache('/profile', '../workspace')).rejects.toThrow('INVALID_MANAGED_SKILL_NAME');
});
test.runIf(process.platform === 'linux')('removes only a revoked managed package and its stage copy without following symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-skill-'));
  const profile = path.join(root, 'profile'), user = path.join(profile, 'skills/users/system_default_user');
  try {
    await mkdir(path.join(user, 'managed-skill'), { recursive: true });
    await mkdir(path.join(user, 'personal-skill'));await writeFile(path.join(user, 'personal-skill/SKILL.md'), 'personal');
    await writeFile(path.join(user, 'managed-skill/SKILL.md'), 'formerly shared');
    await mkdir(path.join(profile, 'rc2-stage-example1/managed-skill'), { recursive: true });
    await writeFile(path.join(profile, 'rc2-stage-example1/managed-skill/SKILL.md'), 'stage');
    await removeManagedSkillCache(profile, 'managed-skill');
    await expect(lstat(path.join(user, 'managed-skill'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(profile, 'rc2-stage-example1/managed-skill'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(user, 'personal-skill/SKILL.md'), 'utf8')).toBe('personal');
    const outside = path.join(root, 'outside');await mkdir(outside);await writeFile(path.join(outside, 'secret'), 'retained');
    await symlink(outside, path.join(user, 'managed-skill'));await removeManagedSkillCache(profile, 'managed-skill');
    expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('retained');
    await rm(user, { recursive: true });await symlink(outside, user);
    await expect(removeManagedSkillCache(profile, 'managed-skill')).rejects.toThrow('MANAGED_SKILL_REVOCATION_CLEANUP_FAILED');
    expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('retained');
  } finally { await rm(root, { recursive: true, force: true }); }
});
