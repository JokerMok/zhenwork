import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { validProxyBindHost } from './proxyBind.mjs';

const MAX_BODY_BYTES = 1_048_576;

// Aionrs speaks OpenAI Chat Completions. This per-login loopback endpoint
// presents that wire format while RC2 retains the real provider credential.
export class EnterpriseModelProxy {
  constructor({ client, model, models = [model], onRevoked = () => {}, requireConversationId = false }) {
    this.client = client;
    this.model = model;
    this.models = models;
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
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
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
    if (
      request.method !== 'POST' ||
      (!conversationId && (this.requireConversationId || request.url !== '/chat/completions'))
    ) {
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
      if (!group) {
        group = new Set();
        this.pendingByConversation.set(conversationId, group);
      }
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
      try {
        payload = JSON.parse(raw);
      } catch {
        response.writeHead(400).end();
        return;
      }
      // Stable internal IDs disambiguate two providers exposing the same model code.
      // Legacy conversations using a vendor code remain valid only when unambiguous.
      const legacy = this.models.filter((item) => item.upstreamCode === payload?.model);
      const selected =
        this.models.find((item) => item.code === payload?.model) || (legacy.length === 1 ? legacy[0] : undefined);
      if (!selected || payload?.stream !== true) {
        response.writeHead(400).end();
        return;
      }
      const forwarded = selected.upstreamCode ? JSON.stringify({ ...payload, model: selected.upstreamCode }) : raw;
      const upstream = await this.client.relayModel(selected.id, forwarded, controller.signal, conversationId);
      // A persisted waiting checkpoint is a transport stop, not a provider
      // credential failure. End without content and without another model call;
      // the durable task remains waiting, never completed by this envelope.
      if (upstream.status === 409 && upstream.headers.get('x-aion-execution-state') === 'paused') {
        const id = `pause-${crypto.randomUUID()}`;
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
        );
        return;
      }
      const contentType = upstream.headers.get('content-type') || '';
      if (
        upstream.status === 401 ||
        upstream.status === 403 ||
        (upstream.ok && !contentType.includes('text/event-stream'))
      ) {
        let errorCode;
        if (upstream.ok) {
          const body = await upstream.json().catch(() => null);
          errorCode = body?.code;
        }
        const revoked = upstream.status === 401 || upstream.status === 403 || errorCode === 401 || errorCode === 403;
        const traceId = crypto.randomUUID();
        console.warn(
          '[Enterprise model diagnostic]',
          JSON.stringify({
            traceId,
            conversationId,
            modelId: selected.id,
            stage: 'relay',
            code: revoked ? 'RELAY_AUTHORIZATION_DENIED' : 'MODEL_RELAY_PROTOCOL_ERROR',
            httpStatus: upstream.status,
          })
        );
        response.writeHead(revoked ? (upstream.status === 403 ? 403 : 401) : 502, { 'X-Aion-Trace-Id': traceId }).end();
        if (revoked) queueMicrotask(this.onRevoked);
        return;
      }
      if (!upstream.ok || !upstream.body) {
        const traceId = crypto.randomUUID();
        console.warn(
          '[Enterprise model diagnostic]',
          JSON.stringify({
            traceId,
            conversationId,
            modelId: selected.id,
            stage: 'upstream',
            code: 'MODEL_RELAY_UNAVAILABLE',
            httpStatus: upstream.status,
          })
        );
        response.writeHead(502, { 'X-Aion-Trace-Id': traceId }).end();
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
