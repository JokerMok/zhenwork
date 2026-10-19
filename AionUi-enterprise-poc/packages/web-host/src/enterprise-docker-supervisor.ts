import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const IMAGE = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/;

async function docker(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const cause = error as { code?: string | number };
    throw new Error(`Docker ${args[0]} failed (${String(cause.code || 'unknown')})`);
  }
}

type DockerObject = { Id: string; Config?: { Labels?: Record<string, string> } };
async function inspect(id: string): Promise<DockerObject> {
  const value = JSON.parse(await docker(['inspect', id])) as DockerObject[];
  if (!Array.isArray(value) || value.length !== 1 || !/^[a-f0-9]{64}$/.test(value[0].Id)) {
    throw new Error('Docker supervisor object invalid');
  }
  return value[0];
}

export type EnterpriseDockerSupervisor = {
  rootKey: string;
  id: string;
  close: () => Promise<void>;
};

/** Docker's unique container name is the host-wide mutex for one profile root. */
export async function acquireEnterpriseDockerSupervisor(root: string, gatewayImage: string):
  Promise<EnterpriseDockerSupervisor> {
  if (!path.isAbsolute(root) || !IMAGE.test(gatewayImage) || process.getuid?.() === 0) {
    throw new Error('Enterprise Docker supervisor configuration invalid');
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entry = await lstat(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Enterprise profile root invalid');
  const canonical = await realpath(root);
  const rootKey = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  const name = `aionui-host-${rootKey}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const id = await docker(['create', '--name', name,
        '--label', 'aionui.enterprise=supervisor', '--label', `aionui.root=${rootKey}`,
        '--label', `aionui.pid=${process.pid}`, gatewayImage]);
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker supervisor ID invalid');
      let closed = false;
      return { rootKey, id, close: async () => {
        if (closed) return;
        await docker(['rm', '-f', id]);
        closed = true;
      } };
    } catch (error) {
      const prior = await inspect(name).catch((): null => null);
      if (!prior) throw error;
      const labels = prior.Config?.Labels || {};
      if (labels['aionui.enterprise'] !== 'supervisor' || labels['aionui.root'] !== rootKey) {
        throw new Error('Docker supervisor name is occupied by an unrelated container');
      }
      const pid = Number(labels['aionui.pid']);
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Docker supervisor PID invalid');
      try {
        process.kill(pid, 0);
        throw new Error('Enterprise Web Host already owns this profile root');
      } catch (signalError) {
        if ((signalError as NodeJS.ErrnoException).code !== 'ESRCH') throw signalError;
      }
      // Remove only the inspected ID. Another process may have won the name race.
      await docker(['rm', '-f', prior.Id]).catch(() => {});
    }
  }
  throw new Error('Could not acquire Enterprise Web Host supervisor');
}
