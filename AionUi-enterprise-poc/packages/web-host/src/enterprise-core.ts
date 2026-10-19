import { randomBytes, createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startBackend } from './backend-launcher.js';
import type { EnterpriseActor, EnterpriseCore } from './enterprise-gateway.js';
import type { AppMetadata } from './types.js';
import { enterpriseCoreBase } from './enterprise-core-address.js';

export async function verifyCoreLocalGate(core: Pick<EnterpriseCore, 'port' | 'localToken' | 'host'>): Promise<void> {
  const url = `${enterpriseCoreBase(core)}/api/system/info`;
  const denied = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (denied.status !== 401) throw new Error('Core accepts requests without the local capability');
  const allowed = await fetch(url, { headers: { 'x-aion-enterprise-local-token': core.localToken },
    signal: AbortSignal.timeout(5000) });
  if (!allowed.ok) throw new Error('Core rejects the local capability');
}

export async function verifyCoreFilesystemGate(core: Pick<EnterpriseCore, 'port' | 'localToken' | 'host'>,
  workspace: string, canary: string): Promise<void> {
  const metadata = async (target: string, root: string): Promise<Response> => fetch(`${enterpriseCoreBase(core)}/api/fs/metadata`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-aion-enterprise-local-token': core.localToken },
    body: JSON.stringify({ path: target, workspace: root }), signal: AbortSignal.timeout(5000),
  });
  const own = await metadata(workspace, workspace);
  if (!own.ok) throw new Error('Isolated Core cannot access its own workspace');
  const host = await metadata(canary, path.dirname(canary));
  if (![400, 403, 404].includes(host.status)) {
    throw new Error(`Isolated Core can access host-only files or filesystem probe failed (${host.status})`);
  }
}

export type EnterpriseCoreStarterOptions = {
  profileRoot: string;
  /** A trusted launcher that confines Core and its child processes to this actor's workspace. */
  isolatedLauncher: string;
  appVersion: string;
  resourcesPath: string;
};

export function enterpriseProfilePath(root: string, actor: EnterpriseActor): string {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(actor.serverId) || !/^[0-9]{1,20}$/.test(actor.userId)) {
    throw new Error('Invalid enterprise actor');
  }
  const serverKey = createHash('sha256').update(actor.serverId).digest('hex').slice(0, 24);
  return path.join(root, 'profiles', serverKey, actor.userId);
}

export async function prepareEnterpriseProfile(root: string, actor: EnterpriseActor): Promise<{
  profile: string; workDir: string; cacheDir: string; logDir: string; tempDir: string;
}> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootEntry = await lstat(root);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('Enterprise profile root must be a directory');
  await chmod(root, 0o700);
  const canonicalRoot = await realpath(root);
  const profile = enterpriseProfilePath(root, actor);
  const workDir = path.join(profile, 'workspace');
  const cacheDir = path.join(profile, 'cache');
  const logDir = path.join(profile, 'logs');
  // Core deletes data-dir/tmp as a legacy Skill directory on every startup.
  // Keep Web uploads in a separate mounted location so conversation file refs survive Core restarts.
  const tempDir = path.join(profile, 'runtime-temp');
  for (const dir of [path.join(root, 'profiles'), path.dirname(profile), profile, workDir, cacheDir, logDir, tempDir]) {
    const existing = await lstat(dir).catch((error: NodeJS.ErrnoException): null => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing?.isSymbolicLink()) throw new Error('Enterprise profile symlink is forbidden');
    if (!existing) await mkdir(dir, { mode: 0o700 });
    const entry = await lstat(dir);
    const expected = path.join(canonicalRoot, path.relative(root, dir));
    if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(dir) !== expected) {
      throw new Error('Enterprise profile symlink is forbidden');
    }
    await chmod(dir, 0o700);
  }
  return { profile, workDir, cacheDir, logDir, tempDir };
}

/**
 * Constructs server-side Core processes, one private profile per RC2 actor.
 * The launcher is required because Core agents may spawn tools; the gateway
 * alone cannot confine their filesystem or network access.
 */
export function createEnterpriseCoreStarter(opts: EnterpriseCoreStarterOptions): (actor: EnterpriseActor) => Promise<EnterpriseCore> {
  const root = path.resolve(opts.profileRoot);
  const launcher = path.resolve(opts.isolatedLauncher);
  if (!path.isAbsolute(opts.profileRoot) || !path.isAbsolute(opts.isolatedLauncher) ||
      !path.isAbsolute(opts.resourcesPath)) {
    throw new Error('Enterprise Core paths must be absolute');
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.appVersion)) throw new Error('Invalid app version');
  return async (actor) => {
    const file = await stat(launcher);
    if (!file.isFile() || (file.mode & 0o111) === 0) throw new Error('Isolated Core launcher is not executable');
    const { profile, workDir, cacheDir, logDir, tempDir } = await prepareEnterpriseProfile(root, actor);
    const token = randomBytes(32).toString('hex');
    const metadata: AppMetadata = { version: opts.appVersion, isPackaged: true,
      resourcesPath: opts.resourcesPath, userDataPath: profile };
    // Use a world-readable host path so a different Unix UID alone cannot make
    // an otherwise unconfined Core pass the filesystem probe.
    const canaryDir = await mkdtemp('/tmp/aionui-host-canary-');
    const canary = path.join(canaryDir, 'probe');
    try {
      await chmod(canaryDir, 0o755);
      await writeFile(canary, randomBytes(32), { flag: 'wx', mode: 0o644 });
      const backend = await startBackend({ app: metadata, resolveBackend: () => launcher,
        dataDir: profile, logDir, dirs: { cacheDir, workDir, logDir }, inheritEnv: false,
        childEnv: { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: tempDir,
          AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_LOCAL_TOKEN: token,
          AION_ENTERPRISE_PROFILE_DIR: profile, AION_ENTERPRISE_SERVER_ID: actor.serverId,
          AION_ENTERPRISE_USER_ID: actor.userId } });
      try {
        const core = { port: backend.port, localToken: token };
        await verifyCoreLocalGate(core);
        await verifyCoreFilesystemGate(core, workDir, canary);
      } catch (error) {
        await backend.stop();
        throw error;
      }
      return { port: backend.port, localToken: token, workspaceRoot: workDir, stop: backend.stop };
    } finally {
      await rm(canaryDir, { recursive: true, force: true });
    }
  };
}
