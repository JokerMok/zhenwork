import test from 'node:test';
import assert from 'node:assert/strict';
import { installEnterpriseWorkerRpc } from '../packages/desktop/src/process/services/enterprise/workerRpc.mjs';

test('worker forwards web conversation actions only from its own window', async () => {
  const previousRole = process.env.AION_ENTERPRISE_ROLE;
  const previousConnected = Object.getOwnPropertyDescriptor(process, 'connected');
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send');
  const messages = [];
  const webContents = {};
  let handler;
  try {
    process.env.AION_ENTERPRISE_ROLE = 'worker';
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    Object.defineProperty(process, 'send', { configurable: true, value: (message) => {
      messages.push(message);
      queueMicrotask(() => process.emit('message', {
        type: 'enterprise:rpc:response', id: message.id, value: { action: message.action },
      }));
    } });
    installEnterpriseWorkerRpc({ handle: (name, callback) => {
      assert.equal(name, 'enterprise:rpc');
      handler = callback;
    } }, () => ({ webContents }));
    const allowed = ['web-conversations', 'web-search', 'web-open', 'web-open-archive',
      'web-rename', 'web-pin', 'web-archive', 'web-delete'];
    for (const action of allowed) {
      assert.deepEqual(await handler({ sender: webContents }, action, { id: '12345678' }), { action });
    }
    assert.deepEqual(messages.map(({ action }) => action), allowed);
    assert.throws(() => handler({ sender: {} }, 'web-open', { id: '12345678' }), /denied/);
    assert.throws(() => handler({ sender: webContents }, 'arbitrary', {}), /denied/);
    assert.equal(messages.length, allowed.length);
  } finally {
    if (previousRole === undefined) delete process.env.AION_ENTERPRISE_ROLE;
    else process.env.AION_ENTERPRISE_ROLE = previousRole;
    if (previousConnected) Object.defineProperty(process, 'connected', previousConnected);
    else delete process.connected;
    if (previousSend) Object.defineProperty(process, 'send', previousSend);
    else delete process.send;
  }
});
