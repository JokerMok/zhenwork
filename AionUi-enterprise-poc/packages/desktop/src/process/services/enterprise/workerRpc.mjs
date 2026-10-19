// The renderer receives only a narrow, non-credentialed IPC surface. The
// supervisor owns the RC2 Cookie and validates every operation server-side.
let requestSupervisor = null;

export function requestEnterpriseSupervisor(action, args, timeoutMs = 10000) {
  if (!requestSupervisor) throw new Error('Enterprise supervisor is unavailable');
  return requestSupervisor(action, args, timeoutMs);
}

export function installEnterpriseWorkerRpc(ipcMain, currentWindow) {
  if (process.env.AION_ENTERPRISE_ROLE !== 'worker') return;
  let nextId = 0;
  const pending = new Map();
  process.on('message', (message) => {
    if (message?.type !== 'enterprise:rpc:response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
  });
  requestSupervisor = (action, args, timeoutMs = 10000) => {
    if (!process.connected) throw new Error('Enterprise supervisor disconnected');
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Enterprise request timed out'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        process.send({ type: 'enterprise:rpc', id, action, args });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };
  ipcMain.handle('enterprise:rpc', (event, action, args) => {
    if (
      !currentWindow() ||
      event.sender !== currentWindow().webContents ||
      !process.connected ||
      !['brand', 'resources', 'documents', 'preview', 'download', 'save',
        'web-conversations', 'web-search', 'web-open', 'web-open-archive', 'web-rename', 'web-pin', 'web-archive', 'web-delete'].includes(action)
    )
      throw new Error('Enterprise request denied');
    return requestEnterpriseSupervisor(action, args);
  });
  process.on('disconnect', () => {
    requestSupervisor = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Session closed'));
    }
    pending.clear();
  });
}
