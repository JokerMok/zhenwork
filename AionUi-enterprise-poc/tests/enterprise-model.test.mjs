import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnterpriseModelProxy } from '../packages/desktop/src/process/services/enterprise/modelProxy.mjs';
import { removeEnterpriseModelProvider, syncEnterpriseModelProvider } from '../packages/desktop/src/process/services/enterprise/modelProvider.mjs';
import { Rc2Client } from '../packages/desktop/src/process/services/enterprise/rc2Client.mjs';

const model = { id: 'cfe01c9f-8a2a-424f-937f-75cb5c0eece9', code: 'fixed-model', name: 'Fixed model' };

test('RC2 model selection keeps only authorized streaming models', async () => {
  const client = new Rc2Client('http://127.0.0.1:3580', 'https://example.test', async (_url, options) => {
    assert.equal(options.headers.clientid, 'client-1');
    assert.equal(options.headers.Cookie, '__Host-workspace-rc2=fixed-session');
    return new Response(JSON.stringify({ code: 200, data: [
      { ...model, streaming: true }, { id: 'other', code: 'other', name: 'Other', streaming: false },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  client.clientId = 'client-1';
  client.cookie = '__Host-workspace-rc2=fixed-session';
  assert.deepEqual(await client.availableModels(), [{ ...model, streaming: true }]);
});

test('loopback proxy streams fixed Chat Completions and rejects unauthorized calls', async () => {
  let forwarded = 0;
  const client = { relayModel: async (id, raw) => {
    forwarded += 1;
    assert.equal(id, model.id);
    assert.equal(JSON.parse(raw).model, model.code);
    return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } };
  const proxy = new EnterpriseModelProxy({ client, model });
  const { port, key } = await proxy.start();
  const url = `http://127.0.0.1:${port}/chat/completions`;
  try {
    const body = JSON.stringify({ model: model.code, stream: true, messages: [{ role: 'user', content: 'short' }] });
    assert.equal((await fetch(url, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'other', stream: true }) })).status, 400);
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /data: \[DONE\]/);
    assert.equal(forwarded, 1);
  } finally { await proxy.stop(); }
});

test('web model proxy requires a Core conversation route and forwards its ID', async () => {
  const seen = [];
  const proxy = new EnterpriseModelProxy({ model, requireConversationId: true,
    client: { relayModel: async (_id, _raw, _signal, conversationId) => {
      seen.push(conversationId);
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } } });
  const { port, key } = await proxy.start();
  const request = (route) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST',
    headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: model.code, stream: true }) });
  try {
    assert.equal((await request('/chat/completions')).status, 404);
    assert.equal((await request('/conversations/../chat/completions')).status, 404);
    assert.equal((await request('/conversations/a1b2c3d4/chat/completions')).status, 200);
    assert.deepEqual(seen, ['a1b2c3d4']);
  } finally { await proxy.stop(); }
});

test('client cancellation aborts the RC2 stream', async () => {
  let upstreamSignal;
  const client = { relayModel: async (_id, _raw, signal) => {
    upstreamSignal = signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
    } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } };
  const proxy = new EnterpriseModelProxy({ client, model });
  const { port, key } = await proxy.start();
  try {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: 'POST', signal: abort.signal, headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model.code, stream: true, messages: [{ role: 'user', content: 'short' }] }),
    });
    await response.body.getReader().read();
    abort.abort();
    for (let i = 0; i < 20 && !upstreamSignal.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamSignal.aborted, true);
  } finally { await proxy.stop(); }
});

test('Core turn cancellation aborts only its authorized conversation model stream', async () => {
  const signals = new Map();
  const proxy = new EnterpriseModelProxy({ model, requireConversationId: true,
    client: { relayModel: async (_id, _raw, signal, conversationId) => {
      signals.set(conversationId, signal);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
      } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    } } });
  const { port, key } = await proxy.start();
  const base = `http://127.0.0.1:${port}/conversations`;
  const headers = { Authorization: `Bearer ${key}` };
  const start = (id) => fetch(`${base}/${id}/chat/completions`, { method: 'POST', headers,
    body: JSON.stringify({ model: model.code, stream: true }) });
  try {
    const first = await start('a1b2c3d4');
    const second = await start('b1c2d3e4');
    await first.body.getReader().read();
    await second.body.getReader().read();
    assert.equal((await fetch(`${base}/a1b2c3d4/cancel`, { method: 'POST' })).status, 401);
    assert.equal(signals.get('a1b2c3d4').aborted, false);
    assert.equal((await fetch(`${base}/a1b2c3d4/cancel`, { method: 'POST', headers })).status, 204);
    assert.equal(signals.get('a1b2c3d4').aborted, true);
    assert.equal(signals.get('b1c2d3e4').aborted, false);
  } finally { await proxy.stop(); }
});

test('RC2 401 closes the local session without forwarding model data', async () => {
  let revoked = 0;
  const client = { relayModel: async () => new Response(JSON.stringify({ code: 401, msg: 'SessionRevoked' }),
    { status: 401, headers: { 'content-type': 'application/json' } }) };
  const proxy = new EnterpriseModelProxy({ client, model, onRevoked: () => { revoked += 1; } });
  const { port, key } = await proxy.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model.code, stream: true, messages: [{ role: 'user', content: 'short' }] }) });
    assert.equal(response.status, 401);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(revoked, 1);
  } finally { await proxy.stop(); }
});

test('AionCore provider receives only a rotating loopback capability', async () => {
  let stored;
  const fetchStub = async (_url, options) => {
    if (!options.method) return new Response(JSON.stringify({ success: true, data: [] }));
    stored = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, data: { id: stored.id } }), { status: 201 });
  };
  const result = await syncEnterpriseModelProvider(32123, 'core-capability', {
    AION_ENTERPRISE_MODEL_PROXY_PORT: '32124', AION_ENTERPRISE_MODEL_PROXY_KEY: 'loopback-only',
    AION_ENTERPRISE_MODEL_CODE: model.code, AION_ENTERPRISE_MODEL_NAME: model.name,
  }, fetchStub);
  assert.equal(result.providerId, 'rc2-enterprise-model');
  assert.equal(stored.api_key, 'loopback-only');
  assert.equal(stored.base_url, 'http://127.0.0.1:32124');
  assert.deepEqual(stored.models, [model.code]);
  assert.equal(stored.model_protocols[model.code], 'openai');
});

test('private Core address uses only its actor network model gateway', async () => {
  const urls = [];
  let stored;
  const fetchStub = async (url, options) => {
    urls.push(url);
    if (!options.method) return new Response(JSON.stringify({ success: true, data: [] }));
    stored = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, data: { id: stored.id } }), { status: 201 });
  };
  await syncEnterpriseModelProvider({ host: '10.233.3.2', port: 32123 }, 'core-capability', {
    AION_ENTERPRISE_MODEL_PROXY_PORT: '32124', AION_ENTERPRISE_MODEL_PROXY_KEY: 'actor-capability',
    AION_ENTERPRISE_MODEL_PROXY_HOST: 'model-gateway',
    AION_ENTERPRISE_MODEL_CODE: model.code, AION_ENTERPRISE_MODEL_NAME: model.name,
  }, fetchStub);
  assert(urls.every((url) => url.startsWith('http://10.233.3.2:32123/')));
  assert.equal(stored.base_url, 'http://model-gateway:32124');
  await assert.rejects(syncEnterpriseModelProvider({ host: '169.254.169.254', port: 32123 },
    'core-capability', { AION_ENTERPRISE_MODEL_PROXY_PORT: '32124',
      AION_ENTERPRISE_MODEL_PROXY_KEY: 'actor-capability', AION_ENTERPRISE_MODEL_CODE: model.code,
      AION_ENTERPRISE_MODEL_NAME: model.name }, fetchStub), /address invalid/);
});

test('reserved provider collision is not overwritten or removed', async () => {
  const mutations = [];
  const fetchStub = async (url, options) => {
    if (options.method) mutations.push(`${options.method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ success: true, data: [{ id: 'rc2-enterprise-model',
      platform: 'custom', base_url: 'https://personal.example' }] }));
  };
  await assert.rejects(syncEnterpriseModelProvider(32123, 'core-capability', {
    AION_ENTERPRISE_MODEL_PROXY_PORT: '32124', AION_ENTERPRISE_MODEL_PROXY_KEY: 'loopback-only',
    AION_ENTERPRISE_MODEL_CODE: model.code, AION_ENTERPRISE_MODEL_NAME: model.name,
  }, fetchStub), /Personal provider conflicts/);
  await assert.rejects(removeEnterpriseModelProvider(32123, 'core-capability', fetchStub),
    /Personal provider conflicts/);
  assert.deepEqual(mutations, []);
});
