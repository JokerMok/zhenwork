import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function classifyEnterpriseError(error) {
  if (['CONNECTION', 'CERTIFICATE'].includes(error?.code)) return 'CONNECTION';
  const message = String(error?.message || '');
  if (/too large/i.test(message)) return 'FILE_TOO_LARGE';
  if (/Session closed|No RC2 session/i.test(message)) return 'SESSION_CLOSED';
  if (/denied|revoked|unavailable|not found/i.test(message)) return 'PERMISSION';
  return 'FAILED';
}

// One worker process contains one Electron renderer, AionCore, WS, MCP and previews.
// Replacing it is the isolation boundary; never hot-swap its in-memory state.
export class EnterpriseLifecycle {
  constructor({ executable, appEntry, onExit = (_reason) => {}, onRequest = async (_action, _args, _child) => undefined,
    onCoreReady = (_port, _child) => {}, spawnImpl = spawn }) {
    this.executable = executable;
    this.appEntry = appEntry;
    this.onExit = onExit;
    this.onRequest = onRequest;
    this.onCoreReady = onCoreReady;
    this.spawnImpl = spawnImpl;
    this.worker = null;
  }

  start({ profileDir, localToken, identity = null, model = null, skill = null, mcp = null, assistantsPath = null }) {
    if (this.worker) throw new Error('Previous account is still running');
    const workerEnv = { ...process.env, AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: profileDir,
      AIONUI_MULTI_INSTANCE: '1',
      ...(identity ? { AION_ENTERPRISE_USER_ID: identity.userId,
        AION_ENTERPRISE_USERNAME: identity.username,
        AION_ENTERPRISE_SERVER_ID: identity.serverId,
        AION_ENTERPRISE_SERVER_URL: identity.serverUrl,
        ...(identity.webOrigin ? { AION_ENTERPRISE_WEB_ORIGIN: identity.webOrigin } : {}) } : {}),
      ...(model ? { AION_ENTERPRISE_MODEL_PROXY_PORT: String(model.port),
        AION_ENTERPRISE_MODEL_ID: model.id, AION_ENTERPRISE_MODEL_CODE: model.code,
        AION_ENTERPRISE_MODEL_NAME: model.name } : {}),
      ...(skill ? { AION_ENTERPRISE_SKILL_PATH: skill.path,
        AION_ENTERPRISE_SKILL_NAME: skill.name,
        AION_ENTERPRISE_SKILL_ID: skill.id,
        AION_ENTERPRISE_SKILL_VERSION: String(skill.version) } : {}),
      ...(assistantsPath ? { AION_ENTERPRISE_ASSISTANTS_PATH: assistantsPath } : {}),
      ...(mcp ? { AION_ENTERPRISE_MCP_PROXY_PORT: String(mcp.port),
        AION_ENTERPRISE_MCP_RESOURCE_ID: mcp.resourceId,
        AION_ENTERPRISE_MCP_VERSION: String(mcp.version) } : {}) };
    delete workerEnv.AION_ENTERPRISE_LOCAL_TOKEN;
    delete workerEnv.AION_ENTERPRISE_MODEL_PROXY_KEY;
    delete workerEnv.AION_ENTERPRISE_MCP_PROXY_KEY;
    const child = this.spawnImpl(this.executable, this.appEntry ? [this.appEntry] : [], {
      env: workerEnv,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      detached: process.platform !== 'win32',
    });
    this.worker = child;
    console.info('[Enterprise] worker started', { pid: child.pid });
    let bootstrapSent = false;
    child.on('message', (message) => {
      if (message?.type === 'enterprise:bootstrap-request' && this.worker === child && !bootstrapSent) {
        bootstrapSent = true;
        child.send({ type: 'enterprise:bootstrap', localToken,
          ...(model ? { modelProxyKey: model.key } : {}),
          ...(mcp ? { mcpProxyKey: mcp.key } : {}) });
        return;
      }
      if (message?.type === 'enterprise:core-ready' && Number.isInteger(message.port) &&
          message.port > 0 && message.port <= 65535 && this.worker === child) this.onCoreReady(message.port, child);
      if (message?.type === 'enterprise:logout') this.onExit('logout');
      if (message?.type === 'enterprise:rpc' && Number.isSafeInteger(message.id) &&
          typeof message.action === 'string') {
        void Promise.resolve().then(() => this.onRequest(message.action, message.args, child))
          .then((value) => { if (this.worker === child && child.connected) child.send({ type: 'enterprise:rpc:response', id: message.id, value }); })
          .catch((error) => { if (this.worker === child && child.connected) child.send({ type: 'enterprise:rpc:response', id: message.id, error: classifyEnterpriseError(error) }); });
      }
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.worker === child) this.worker = null;
      this.onExit('exit');
    };
    child.once('exit', (code, signal) => {
      console.warn('[Enterprise] worker exited', { code, signal });
      finish();
    });
    child.once('error', (error) => {
      console.error('[Enterprise] worker process error', error?.message || 'unknown');
      finish();
    });
    return child;
  }

  async stop() {
    const child = this.worker;
    if (!child) return;
    this.worker = null;
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => {
      child.once('exit', resolve);
      child.once('error', resolve);
    });
    try { child.send?.({ type: 'enterprise:stop' }); } catch { /* closed IPC; force stop below */ }
    let timer;
    const graceful = await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10000); })]);
    clearTimeout(timer);
    if (graceful) return;
    if (process.platform === 'win32') {
      await new Promise((resolve) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => resolve()));
    } else if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  async quiesceWorker(timeoutMs = 5000) {
    const child = this.worker;
    if (!child?.connected) throw new Error('Employee worker is unavailable');
    const nonce = randomUUID();
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onExit);
      };
      const onMessage = (message) => {
        if (message?.type !== 'enterprise:update-quiesced' || message.nonce !== nonce) return;
        cleanup();
        if (this.worker !== child) reject(new Error('Employee worker changed during update'));
        else resolve();
      };
      const onExit = () => { cleanup(); reject(new Error('Employee worker exited during update')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Employee worker did not confirm update pause')); }, timeoutMs);
      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onExit);
      try { child.send({ type: 'enterprise:update-quiesce', nonce }, (error) => { if (error) onExit(); }); }
      catch { onExit(); }
    });
  }
}
