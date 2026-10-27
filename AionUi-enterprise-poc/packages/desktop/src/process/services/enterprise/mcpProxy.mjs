import crypto from 'node:crypto';
import http from 'node:http';
import { validProxyBindHost } from './proxyBind.mjs';

const MAX_BYTES = 1_048_576;

// AionCore receives a per-login loopback capability. RC2 checks the employee
// and connection on every JSON-RPC exchange and retains the upstream secret.
export class EnterpriseMcpProxy {
  constructor({ client, connectionId, onRevoked = () => {}, requireConversationId = false }) {
    this.client = client;
    this.connectionId = connectionId;
    this.onRevoked = onRevoked;
    this.requireConversationId = requireConversationId;
    this.key = crypto.randomBytes(32).toString('hex');
    this.server = null;
    this.pending = new Set();
  }

  async start(listenHost = '127.0.0.1') {
    if (this.server) throw new Error('MCP proxy already started');
    if (!validProxyBindHost(listenHost)) throw new Error('MCP proxy bind address invalid');
    this.server = http.createServer((req, res) => { void this.handle(req, res); });
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

  idempotencyKey(raw, headers, conversationId) {
    let message;
    try { message = JSON.parse(raw); } catch { return null; }
    if (message?.method !== 'tools/call') return null;
    const session = typeof headers['mcp-session-id'] === 'string' ? headers['mcp-session-id'] : '';
    const hex = crypto.createHash('sha256').update([
      this.connectionId, conversationId || '', session, raw,
    ].join('\n')).digest('hex').slice(0, 32).split('');
    hex[12] = '4';
    hex[16] = '8';
    return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
  }

  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const conversationId = /^\/conversations\/([A-Za-z0-9_-]{1,100})\/mcp$/.exec(req.url || '')?.[1];
    if (req.method !== 'POST' || (!conversationId && (this.requireConversationId || req.url !== '/mcp'))) {
      res.writeHead(404).end(); return;
    }
    if (!this.authorized(req.headers.authorization)) { res.writeHead(401).end(); return; }
    const controller = new AbortController();
    this.pending.add(controller);
    res.once('close', () => controller.abort());
    try {
      let length = 0;
      const chunks = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BYTES) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      const idempotencyKey = this.idempotencyKey(raw, req.headers, conversationId);
      const relayHeaders = idempotencyKey ? { ...req.headers,
        'x-zhenwork-idempotency-key': idempotencyKey } : req.headers;
      const upstream = await this.client.relayMcp(this.connectionId, raw, relayHeaders, controller.signal, conversationId);
      const data = Buffer.from(await upstream.arrayBuffer());
      if (data.length > MAX_BYTES) { res.writeHead(502).end(); return; }
      let revoked = upstream.status === 401 || upstream.status === 403;
      if (!revoked && upstream.headers.get('content-type')?.includes('application/json')) {
        try { revoked = [401, 403].includes(JSON.parse(data.toString()).code); } catch { /* JSON-RPC body */ }
      }
      if (revoked) {
        res.writeHead(401).end();
        queueMicrotask(this.onRevoked);
        return;
      }
      if (!upstream.ok) { res.writeHead(502).end(); return; }
      // Preserve empty Streamable HTTP notification acknowledgments; there is
      // no JSON-RPC response body to wrap as a successful 200 JSON message.
      if ([202, 204].includes(upstream.status) && data.length === 0) {
        res.writeHead(upstream.status).end();
        return;
      }
      const type = upstream.headers.get('content-type') || 'application/json';
      if (!type.startsWith('application/json') && !type.startsWith('text/event-stream')) {
        res.writeHead(502).end(); return;
      }
      res.writeHead(200, { 'Content-Type': type,
        ...(upstream.headers.get('mcp-session-id') ? { 'Mcp-Session-Id': upstream.headers.get('mcp-session-id') } : {}) });
      res.end(data);
    } catch {
      if (!controller.signal.aborted && !res.headersSent) res.writeHead(502).end();
      else if (!res.destroyed) res.destroy();
    } finally { this.pending.delete(controller); }
  }

  async stop() {
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
