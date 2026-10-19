import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { validProxyBindHost } from './proxyBind.mjs';

const MAX_BODY_BYTES = 1_048_576;

// Aionrs speaks OpenAI Chat Completions. This per-login loopback endpoint
// presents that wire format while RC2 retains the real provider credential.
export class EnterpriseModelProxy {
  constructor({ client, model, onRevoked = () => {}, requireConversationId = false }) {
    this.client = client;
    this.model = model;
    this.onRevoked = onRevoked;
    this.requireConversationId = requireConversationId;
    this.key = crypto.randomBytes(32).toString('hex');
    this.server = null;
    this.pending = new Set();
    this.pendingByConversation = new Map();
  }

  async start(listenHost = '127.0.0.1') {
    if (this.server) throw new Error('Model proxy already started');
    if (!validProxyBindHost(listenHost)) throw new Error('Model proxy bind address invalid');
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, listenHost, resolve);
    });
    return { port: this.server.address().port, key: this.key };
  }

  authorized(value) {
    const expected = Buffer.from(`Bearer ${this.key}`);
    const actual = Buffer.from(value || '');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    const cancelId = /^\/conversations\/([A-Za-z0-9_-]{1,100})\/cancel$/.exec(request.url || '')?.[1];
    if (request.method === 'POST' && cancelId) {
      if (!this.authorized(request.headers.authorization)) return response.writeHead(401).end();
      for (const controller of this.pendingByConversation.get(cancelId) || []) controller.abort();
      return response.writeHead(204).end();
    }
    const conversationId = /^\/conversations\/([A-Za-z0-9_-]{1,100})\/chat\/completions$/.exec(request.url || '')?.[1];
    if (request.method !== 'POST' || (!conversationId &&
        (this.requireConversationId || request.url !== '/chat/completions'))) {
      response.writeHead(404).end();
      return;
    }
    if (!this.authorized(request.headers.authorization)) {
      response.writeHead(401).end();
      return;
    }
    const controller = new AbortController();
    this.pending.add(controller);
    if (conversationId) {
      let group = this.pendingByConversation.get(conversationId);
      if (!group) { group = new Set(); this.pendingByConversation.set(conversationId, group); }
      group.add(controller);
    }
    response.once('close', () => controller.abort());
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload;
      try { payload = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
      if (payload?.model !== this.model.code || payload?.stream !== true) {
        response.writeHead(400).end();
        return;
      }
      const upstream = await this.client.relayModel(this.model.id, raw, controller.signal, conversationId);
      const contentType = upstream.headers.get('content-type') || '';
      if (upstream.status === 401 || upstream.status === 403 || (upstream.ok && !contentType.includes('text/event-stream'))) {
        let errorCode;
        if (upstream.ok) {
          const body = await upstream.json().catch(() => null);
          errorCode = body?.code;
        }
        const revoked = upstream.status === 401 || upstream.status === 403 || errorCode === 401 || errorCode === 403;
        response.writeHead(revoked ? 401 : 502).end();
        if (revoked) queueMicrotask(this.onRevoked);
        return;
      }
      if (!upstream.ok || !upstream.body) {
        response.writeHead(502).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
      for await (const chunk of upstream.body) {
        if (controller.signal.aborted) break;
        if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
      }
      response.end();
    } catch (error) {
      if (!controller.signal.aborted && !response.headersSent) response.writeHead(502).end();
      else if (!response.destroyed) response.destroy();
    } finally {
      this.pending.delete(controller);
      if (conversationId) {
        const group = this.pendingByConversation.get(conversationId);
        group?.delete(controller);
        if (group?.size === 0) this.pendingByConversation.delete(conversationId);
      }
    }
  }

  async stop() {
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    this.pendingByConversation.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
