import test from 'node:test';
import assert from 'node:assert/strict';
import { Rc2Client } from '../packages/desktop/src/process/services/enterprise/rc2Client.mjs';

const baseId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';

test('authorized RC2 document enters the native local-file lane; revoke stops later reads', async () => {
  let allowed = true;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, cookie: options.headers?.Cookie });
    assert.equal(options.headers?.Cookie, '__Host-workspace-rc2=fixed');
    if (path === `/ai/files/${fileId}/download`) return new Response('fixed office source', { status: allowed ? 200 : 403 });
    const send = (data, status = 200) => new Response(JSON.stringify({ code: status, data }), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (path === `/ai/resources/${baseId}`) return send(allowed ? {
      resourceType: 'KNOWLEDGE', actions: ['VIEW', 'USE'], version: 2, publishedVersion: 2,
    } : null, allowed ? 200 : 403);
    if (path === `/ai/knowledge/${baseId}/documents`) return send([{ id: documentId, title: '固定资料.txt', version: 2, file_id: fileId }]);
    if (path === `/ai/knowledge/documents/${documentId}/versions/2`) return send({
      documentId, version: 2, filename: '固定资料.txt', fileId, content: 'fixed office source',
    });
    throw new Error(`Unexpected path ${path}`);
  };
  const client = new Rc2Client('https://rc2.test', 'https://rc2.test', fetchImpl);
  client.cookie = '__Host-workspace-rc2=fixed';
  client.clientId = 'fixed-client';
  const docs = await client.knowledgeDocuments(baseId);
  assert.equal(docs.length, 1);
  await client.authorizedDocument(baseId, documentId, 2);
  const preview = await client.knowledgePreview(documentId, 2);
  assert.equal(preview.content, 'fixed office source');
  const download = await client.knowledgeFile(documentId, 2);
  assert.equal(download.bytes.toString(), 'fixed office source');
  assert(calls.some((call) => call.path === `/ai/files/${fileId}/download`));
  allowed = false;
  await assert.rejects(client.authorizedDocument(baseId, documentId, 2), /resource unavailable/);
});
