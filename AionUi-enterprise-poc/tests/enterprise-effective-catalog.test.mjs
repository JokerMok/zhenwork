import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rc2Client } from '../packages/desktop/src/process/services/enterprise/rc2Client.mjs';

test('RC2 resource catalog uses the server-authoritative available scope across pages', async () => {
  const requests = [];
  const firstPage = Array.from({ length: 30 }, (_, index) => ({
    id: `resource-${index}`,
    name: `Resource ${index}`,
    description: '',
    actions: ['VIEW', 'USE'],
    publishedVersion: index + 1,
    source: index === 0 ? 'PERSONAL' : 'ORGANIZATION',
  }));
  const secondPage = [{
    id: 'resource-30',
    name: 'Resource 30',
    description: 'last page',
    actions: ['USE'],
    publishedVersion: 31,
    source: 'ORGANIZATION',
  }, {
    id: 'view-only',
    name: 'View only',
    actions: ['VIEW'],
    publishedVersion: 1,
    source: 'ORGANIZATION',
  }, {
    id: 'draft',
    name: 'Draft',
    actions: ['USE'],
    publishedVersion: null,
    source: 'ORGANIZATION',
  }];
  const client = new Rc2Client('http://127.0.0.1:3580', 'https://workspace.test', async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.pathname + parsed.search);
    const data = parsed.searchParams.get('page') === '1' ? firstPage : secondPage;
    return new Response(JSON.stringify({ code: 200, data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const resources = await client.resources('ASSISTANT');

  assert.deepEqual(requests, [
    '/ai/resources?type=ASSISTANT&scope=available&page=1',
    '/ai/resources?type=ASSISTANT&scope=available&page=2',
  ]);
  assert.equal(resources.length, 31);
  assert.deepEqual(resources[0], {
    id: 'resource-0',
    name: 'Resource 0',
    description: '',
    version: 1,
    source: 'personal',
    type: 'ASSISTANT',
  });
  assert.equal(resources.at(-1).id, 'resource-30');
  assert.equal(resources.at(-1).source, 'enterprise');
  assert.equal(resources.some((item) => item.id === 'view-only' || item.id === 'draft'), false);
});
