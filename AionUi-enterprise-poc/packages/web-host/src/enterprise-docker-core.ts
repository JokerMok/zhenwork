import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { prepareEnterpriseProfile, verifyCoreFilesystemGate, verifyCoreLocalGate } from './enterprise-core.js';
import type { EnterpriseActor, EnterpriseCore } from './enterprise-gateway.js';
import type { EnterpriseDockerSupervisor } from './enterprise-docker-supervisor.js';

const execFileAsync = promisify(execFile);
const IMAGE = /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64})$/;
const CORE_PORT = 3000;

export type EnterpriseDockerCoreOptions = {
  profileRoot: string;
  appVersion: string;
  coreImage: string;
  gatewayImage: string;
  supervisor: EnterpriseDockerSupervisor;
  /** Optional operator-owned host HTTPS proxy; only its loopback port is passed to the bridge. */
  upstreamProxyPort?: number;
  /** Host-only RC2 check performed immediately before a Core cron turn. */
  authorizeCronJob?: (actor: EnterpriseActor, jobId: string) => Promise<boolean>;
};

async function docker(args: string[], timeout = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('docker', args, { timeout, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    // Docker's command line may carry a capability. Do not echo its arguments.
    const cause = error as { code?: string | number; stderr?: string };
    const failure = new Error(`Docker ${args[0]} failed (${String(cause.code || 'unknown')})`) as Error &
      { dockerStderr: string };
    failure.dockerStderr = String(cause.stderr || '').slice(0, 2000);
    throw failure;
  }
}

/** Deliver the one-use capability through stdin into container tmpfs, never OCI env or argv. */
async function deliverCapability(container: string, uid: number, gid: number, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', '--user', `${uid}:${gid}`, container,
      'sh', '-c', 'umask 077; cat > /run/aionui/.local-token.tmp && mv /run/aionui/.local-token.tmp /run/aionui/local-token'],
    { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Docker capability delivery failed')); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Docker capability delivery failed'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(token);
  });
}

async function mappedPort(container: string, port: number): Promise<number> {
  const output = await docker(['port', container, `${port}/tcp`]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(output);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('Docker bridge port is not bound to host loopback');
  }
  return Number(match[1]);
}

async function hostProxyBindHost(): Promise<string> {
  if (process.platform === 'darwin') return '127.0.0.1';
  if (process.platform !== 'linux') throw new Error('Enterprise Docker Core requires a Unix Docker host');
  const raw = await docker(['network', 'inspect', 'bridge']);
  const item = (JSON.parse(raw) as Array<{ IPAM?: { Config?: Array<{ Gateway?: string }> } }>)[0];
  const gateway = item?.IPAM?.Config?.[0]?.Gateway;
  const owned = Object.values(networkInterfaces()).flat().some((address) =>
    address?.family === 'IPv4' && address.address === gateway);
  if (typeof gateway !== 'string' || !owned ||
      !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(gateway)) {
    throw new Error('Docker host gateway address is not locally owned and private');
  }
  return gateway;
}

async function reapStaleActor(rootKey: string, actorKey: string): Promise<void> {
  const filters = ['--filter', `label=aionui.root=${rootKey}`,
    '--filter', `label=aionui.actor=${actorKey}`];
  const containers = (await docker(['ps', '-aq', ...filters])).split('\n').filter(Boolean);
  for (const id of containers) {
    const raw = await docker(['inspect', id]);
    const item = (JSON.parse(raw) as Array<{ Id: string; Config?: { Labels?: Record<string, string> } }>)[0];
    const labels = item?.Config?.Labels || {};
    if (labels['aionui.enterprise'] !== '1' || labels['aionui.root'] !== rootKey ||
        labels['aionui.actor'] !== actorKey || !/^[a-f0-9]{64}$/.test(item.Id)) {
      throw new Error('Untrusted stale Enterprise container');
    }
    await docker(['rm', '-f', item.Id]);
  }
  const networks = (await docker(['network', 'ls', '-q', ...filters])).split('\n').filter(Boolean);
  for (const id of networks) {
    const raw = await docker(['network', 'inspect', id]);
    const item = (JSON.parse(raw) as Array<{ Id: string; Labels?: Record<string, string> }>)[0];
    const labels = item?.Labels || {};
    if (labels['aionui.enterprise'] !== '1' || labels['aionui.root'] !== rootKey ||
        labels['aionui.actor'] !== actorKey || !/^[a-f0-9]{64}$/.test(item.Id)) {
      throw new Error('Untrusted stale Enterprise network');
    }
    await docker(['network', 'rm', item.Id]);
  }
}

async function waitForCore(core: EnterpriseCore, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await verifyCoreLocalGate(core); return; }
    catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Container Core did not pass local capability gate: ${String(last)}`);
}

async function waitForBridge(url: string, token: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${url}/health`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch { /* Container may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Docker bridge control is unavailable');
}

/**
 * Starts Core on an actor-only internal network. A small bridge exposes only
 * Core's port to host loopback and admits explicit model/MCP proxy ports.
 */
export function createEnterpriseDockerCoreStarter(opts: EnterpriseDockerCoreOptions):
  (actor: EnterpriseActor) => Promise<EnterpriseCore> {
  if (!path.isAbsolute(opts.profileRoot) || !IMAGE.test(opts.coreImage) || !IMAGE.test(opts.gatewayImage) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(opts.appVersion) ||
      !/^[a-f0-9]{20}$/.test(opts.supervisor?.rootKey) || !/^[a-f0-9]{64}$/.test(opts.supervisor?.id)) {
    throw new Error('Enterprise Docker Core configuration invalid');
  }
  if (opts.upstreamProxyPort !== undefined &&
      (!Number.isInteger(opts.upstreamProxyPort) || opts.upstreamProxyPort < 1 || opts.upstreamProxyPort > 65535)) {
    throw new Error('Enterprise upstream proxy port invalid');
  }
  const root = path.resolve(opts.profileRoot);
  return async (actor) => {
    const { profile, workDir, cacheDir, logDir, tempDir } = await prepareEnterpriseProfile(root, actor);
    const proxyBindHost = await hostProxyBindHost();
    if (profile.includes(',')) throw new Error('Enterprise profile path contains an unsupported comma');
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0) {
      throw new Error('Enterprise Docker Web Host must run as a non-root Unix user');
    }
    const key = createHash('sha256').update(`${actor.serverId}:${actor.userId}`).digest('hex').slice(0, 16);
    await reapStaleActor(opts.supervisor.rootKey, key);
    const suffix = randomBytes(5).toString('hex');
    const prefix = `aionui-${key}-${suffix}`;
    const network = `${prefix}-net`;
    const gateway = `${prefix}-gateway`;
    const coreName = `${prefix}-core`;
    const token = randomBytes(32).toString('hex');
    const bridgeToken = randomBytes(32).toString('hex');
    let networkCreated = false;
    let gatewayCreated = false;
    let coreCreated = false;
    let authServer: http.Server | undefined;
    let authPort = 0;
    let gatewayIp = '';
    let coreIp = '';
    let stopPromise: Promise<void> | null = null;
    let invalidate!: () => void;
    const invalidated = new Promise<void>((resolve) => { invalidate = resolve; });
    const cleanup = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      invalidate();
      stopPromise = (async () => {
        const failures: Error[] = [];
        const remove = async (args: string[], missing: RegExp) => {
          try { await docker(args); }
          catch (error) {
            if (!missing.test(String((error as { dockerStderr?: string }).dockerStderr || ''))) {
              failures.push(error as Error);
            }
          }
        };
        if (coreCreated) await remove(['rm', '-f', coreName], /No such container/i);
        if (gatewayCreated) await remove(['rm', '-f', gateway], /No such container/i);
        if (networkCreated) await remove(['network', 'rm', network], /not found|No such network/i);
        if (authServer) {
          authServer.closeAllConnections();
          try { await new Promise<void>((resolve, reject) => authServer!.close((error) =>
            error ? reject(error) : resolve())); }
          catch (error) { failures.push(error as Error); }
        }
        if (failures.length) throw new AggregateError(failures, 'Enterprise Docker cleanup incomplete');
      })();
      return stopPromise;
    };
    const canaryDir = await mkdtemp('/tmp/aionui-host-canary-');
    const canary = path.join(canaryDir, 'probe');
    try {
      await chmod(canaryDir, 0o755);
      await writeFile(canary, randomBytes(32), { flag: 'wx', mode: 0o644 });
      if (opts.authorizeCronJob) {
        const server = http.createServer((req, res) => {
          const supplied = req.headers['x-aion-enterprise-local-token'];
          const credential = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
          const expected = Buffer.from(token);
          if (req.method !== 'GET' || !/^\/job\/cron_[A-Za-z0-9_-]{8,80}$/.test(req.url || '') ||
              credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
            res.writeHead(403); res.end(); return;
          }
          const jobId = req.url!.slice('/job/'.length);
          void opts.authorizeCronJob!(actor, jobId).then((allowed) => {
            if (!res.destroyed) { res.writeHead(allowed ? 204 : 403); res.end(); }
          }, () => { if (!res.destroyed) { res.writeHead(503); res.end(); } });
        });
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, proxyBindHost, () => { server.off('error', reject); resolve(); });
        });
        authServer = server;
        authPort = (server.address() as { port: number }).port;
      }
      for (let attempt = 0; attempt < 128; attempt++) {
        const third = randomInt(0, 256);
        const base = randomInt(0, 16) * 16;
        const subnet = `10.238.${third}.${base}/28`;
        try {
          await docker(['network', 'create', '--internal', '--subnet', subnet,
            '--label', 'aionui.enterprise=1', '--label', `aionui.actor=${key}`,
            '--label', `aionui.root=${opts.supervisor.rootKey}`, network]);
          networkCreated = true;
          gatewayIp = `10.238.${third}.${base + 3}`;
          coreIp = `10.238.${third}.${base + 2}`;
          break;
        } catch { /* Another actor may own this subnet; try another. */ }
      }
      if (!networkCreated) throw new Error('No private Docker subnet available');

      await docker(['run', '-d', '--name', gateway, '--network', 'bridge',
        '--label', 'aionui.enterprise=1', '--label', `aionui.actor=${key}`,
        '--label', `aionui.root=${opts.supervisor.rootKey}`,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '128m', '--cpus', '1',
        '--add-host', 'host.docker.internal:host-gateway',
        '-p', '127.0.0.1::3100', '-p', '127.0.0.1::3101',
        '-e', `AION_CORE_PORT=${CORE_PORT}`, '-e', `AION_BRIDGE_CONTROL_TOKEN=${bridgeToken}`,
        '-e', `AION_BRIDGE_ACTOR_IP=${gatewayIp}`,
        ...(opts.upstreamProxyPort ? ['-e', `AION_BRIDGE_UPSTREAM_PROXY_PORT=${opts.upstreamProxyPort}`] : []),
        opts.gatewayImage]);
      gatewayCreated = true;
      await docker(['network', 'connect', '--ip', gatewayIp, '--alias', 'model-gateway', network, gateway]);
      const hostCorePort = await mappedPort(gateway, 3100);
      const hostControlPort = await mappedPort(gateway, 3101);
      const controlUrl = `http://127.0.0.1:${hostControlPort}`;
      const headers = { authorization: `Bearer ${bridgeToken}` };
      await waitForBridge(controlUrl, bridgeToken);
      const egress = await fetch(`${controlUrl}/egress/enable`, {
        method: 'POST', headers, signal: AbortSignal.timeout(5_000),
      });
      if (egress.status !== 204) throw new Error('Docker HTTPS egress policy unavailable');
      if (authPort) {
        const admitted = await fetch(`${controlUrl}/route`, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ port: authPort }), signal: AbortSignal.timeout(5_000),
        });
        if (admitted.status !== 204) throw new Error('Docker bridge rejected cron authorization port');
      }

      await docker(['run', '-d', '--name', coreName, '--network', network, '--ip', coreIp, '--network-alias', 'core',
        '--label', 'aionui.enterprise=1', '--label', `aionui.actor=${key}`,
        '--label', `aionui.root=${opts.supervisor.rootKey}`,
        '--user', `${uid}:${gid}`, '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '256',
        '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '--tmpfs', `/run/aionui:rw,nosuid,nodev,noexec,size=1m,uid=${uid},gid=${gid},mode=0700`,
        '--mount', `type=bind,src=${profile},dst=${profile}`,
        '--workdir', profile,
        '-e', `HOME=${profile}`, '-e', `AION_ENTERPRISE_ROLE=worker`,
        '-e', 'AION_ENTERPRISE_WEB_CORE=1',
        '-e', 'AION_ENTERPRISE_LOCAL_TOKEN_FILE=/run/aionui/local-token',
        '-e', `AION_ENTERPRISE_PROFILE_DIR=${profile}`,
        '-e', `AION_ENTERPRISE_SERVER_ID=${actor.serverId}`, '-e', `AION_ENTERPRISE_USER_ID=${actor.userId}`,
        ...(authPort ? ['-e', `AION_ENTERPRISE_CRON_AUTH_PORT=${authPort}`] : []),
        '-e', `AIONUI_CACHE_DIR=${cacheDir}`, '-e', `AIONUI_WORK_DIR=${workDir}`,
        '-e', `AIONUI_LOG_DIR=${logDir}`,
        '-e', `TMPDIR=${tempDir}`,
        '-e', 'HTTPS_PROXY=http://model-gateway:3128',
        '-e', 'https_proxy=http://model-gateway:3128',
        '-e', 'NO_PROXY=model-gateway,core,localhost,127.0.0.1',
        '-e', 'no_proxy=model-gateway,core,localhost,127.0.0.1',
        '-e', 'NODE_USE_ENV_PROXY=1',
        opts.coreImage, '--host', '0.0.0.0', '--port', String(CORE_PORT),
        '--data-dir', profile, '--work-dir', workDir, '--log-dir', logDir,
        '--app-version', opts.appVersion, '--managed-resources-mode', 'bundled', '--local']);
      coreCreated = true;
      await deliverCapability(coreName, uid, gid, token);
      const result: EnterpriseCore = {
        host: '127.0.0.1', port: hostCorePort, localToken: token,
        workspaceRoot: workDir,
        proxyHost: 'model-gateway', proxyBindHost, networkMode: 'container', invalidated,
        registerProxyPort: async (port) => {
          if (stopPromise || !Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new Error('Enterprise proxy port invalid');
          }
          const response = await fetch(`${controlUrl}/route`, {
            method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ port }), signal: AbortSignal.timeout(5_000),
          });
          if (response.status !== 204) throw new Error('Docker bridge rejected enterprise proxy port');
        },
        unregisterProxyPort: async (port) => {
          if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
          const response = await fetch(`${controlUrl}/route`, {
            method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ port }), signal: AbortSignal.timeout(5_000),
          });
          if (response.status !== 204) throw new Error('Docker bridge did not revoke enterprise proxy port');
        },
        stop: cleanup,
      };
      await waitForCore(result);
      await verifyCoreFilesystemGate(result, workDir, canary);
      void docker(['wait', coreName], 24 * 60 * 60 * 1000).then(invalidate, invalidate);
      return result;
    } catch (error) {
      try { await cleanup(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Core startup and cleanup failed'); }
      throw error;
    } finally {
      await rm(canaryDir, { recursive: true, force: true });
    }
  };
}
