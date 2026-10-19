import { expect, test, vi } from 'vitest';

test('enterprise browser sockets wait for user activity after idle Core reclamation', async () => {
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    constructor(_url: string) {
      super();
      sockets.push(this);
    }
    send(): void {}
    close(): void { this.readyState = FakeWebSocket.CLOSED; }
  }
  (window as typeof window & { __AION_ENTERPRISE_WEB__?: boolean }).__AION_ENTERPRISE_WEB__ = true;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  try {
    await import('../../packages/desktop/src/common/adapter/browser');
    const { wsEmitter } = await import('../../packages/desktop/src/common/adapter/httpBridge');
    const unsubscribe = wsEmitter('test').on(() => {});
    expect(sockets).toHaveLength(2);
    for (const socket of sockets) {
      socket.readyState = FakeWebSocket.OPEN;
      socket.dispatchEvent(new Event('open'));
      socket.readyState = FakeWebSocket.CLOSED;
      socket.dispatchEvent(new CloseEvent('close', { code: 4001 }));
    }
    expect(sockets).toHaveLength(2);
    window.dispatchEvent(new MouseEvent('pointerdown'));
    expect(sockets).toHaveLength(4);
    unsubscribe();
  } finally {
    vi.unstubAllGlobals();
    delete (window as typeof window & { __AION_ENTERPRISE_WEB__?: boolean }).__AION_ENTERPRISE_WEB__;
  }
});
