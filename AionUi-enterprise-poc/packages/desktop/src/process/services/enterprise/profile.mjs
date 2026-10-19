import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

export function profilePath(root, serverId, userId) {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(serverId)) throw new Error('Invalid enterprise server ID');
  if (!/^[0-9]{1,20}$/.test(userId)) throw new Error('Invalid sys_user.user_id');
  const serverKey = createHash('sha256').update(serverId).digest('hex').slice(0, 24);
  return path.join(root, 'profiles', serverKey, userId);
}

export async function prepareProfile(root, serverId, userId) {
  const dir = profilePath(root, serverId, userId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  return { dir, localToken: randomBytes(32).toString('hex') };
}
