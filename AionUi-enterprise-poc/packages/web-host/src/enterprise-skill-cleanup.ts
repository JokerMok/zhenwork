import { execFile } from 'node:child_process';
import path from 'node:path';

// Core's delete endpoint deliberately soft-deletes personal Skills. Enterprise
// revocation must additionally remove its own managed cache, without following
// Core-writable symlinks or touching employee workspace/personal Skill names.
export const MANAGED_SKILL_CLEANUP_SCRIPT = String.raw`
import json,os,re,shutil,stat,sys,resource
resource.setrlimit(resource.RLIMIT_AS,(128*1024*1024,128*1024*1024))
resource.setrlimit(resource.RLIMIT_CPU,(5,5))
value=json.load(sys.stdin);profile=value['profile'];name=value['name']
if not re.fullmatch(r'[a-z0-9-]{1,64}',name):raise ValueError('INVALID_MANAGED_SKILL_NAME')
if not shutil.rmtree.avoids_symlink_attacks:raise RuntimeError('SAFE_TREE_REMOVAL_UNAVAILABLE')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
root=os.open(profile,flags)
try:
 if os.path.realpath('/proc/self/fd/'+str(root))!=profile:raise ValueError('PROFILE_ROOT_INVALID')
 def remove(parent):
  try:info=os.stat(name,dir_fd=parent,follow_symlinks=False)
  except FileNotFoundError:return
  if stat.S_ISDIR(info.st_mode):shutil.rmtree(name,dir_fd=parent)
  else:os.unlink(name,dir_fd=parent)
 def installed():
  opened=[];parent=root
  try:
   for part in ('skills','users','system_default_user'):
    try:child=os.open(part,flags,dir_fd=parent)
    except FileNotFoundError:return
    opened.append(child);parent=child
   remove(parent)
  finally:
   for fd in reversed(opened):os.close(fd)
 installed()
 # Remove the same managed package from orphaned Host staging caches, too.
 # Only package directories are removed; other resources and user files stay.
 with os.scandir(root) as entries:
  for count,entry in enumerate(entries):
   if count>=1000:raise ValueError('PROFILE_CACHE_SCAN_LIMIT')
   if not re.fullmatch(r'rc2-stage-[A-Za-z0-9]+',entry.name):continue
   try:stage=os.open(entry.name,flags,dir_fd=root)
   except FileNotFoundError:continue
   try:remove(stage)
   finally:os.close(stage)
finally:os.close(root)
print('MANAGED_SKILL_CACHE_REMOVED')
`;
export async function removeManagedSkillCache(profile: string, name: string): Promise<void> {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error('INVALID_MANAGED_SKILL_NAME');
  if (process.platform !== 'linux' || !path.isAbsolute(profile) || path.resolve(profile) !== profile)
    throw new Error('MANAGED_SKILL_CLEANUP_REQUIRES_LINUX_PROFILE');
  await new Promise<void>((resolve, reject) => {
    const child = execFile('/usr/bin/python3', ['-c', MANAGED_SKILL_CLEANUP_SCRIPT],
      { timeout: 10_000, maxBuffer: 16_384, encoding: 'utf8' }, (error, stdout) => {
        if (error || stdout.trim() !== 'MANAGED_SKILL_CACHE_REMOVED') reject(new Error('MANAGED_SKILL_REVOCATION_CLEANUP_FAILED'));
        else resolve();
      });
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ profile, name }));
  });
}
