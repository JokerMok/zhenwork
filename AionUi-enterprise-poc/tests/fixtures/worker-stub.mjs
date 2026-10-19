import { spawn } from 'node:child_process';

const core = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  detached: process.platform !== 'win32', stdio: 'ignore',
});
process.send?.({ type: 'test:core-pid', pid: core.pid });
process.on('message', (message) => {
  if (message?.type !== 'enterprise:stop') return;
  if (process.platform === 'win32') core.kill();
  else { try { process.kill(-core.pid, 'SIGTERM'); } catch { /* already exited */ } }
  core.once('exit', () => process.exit(0));
});
