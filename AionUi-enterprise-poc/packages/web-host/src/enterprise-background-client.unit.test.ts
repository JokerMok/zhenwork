import { expect, test } from 'vitest';
import { EnterpriseBackgroundClient } from './enterprise-background-client.js';

test('background resources use the same server-authoritative available catalog as interactive sessions', async () => {
  const requests: string[] = [];
  const firstPage = Array.from({ length: 30 }, (_, index) => ({
    id: `resource-${index}`,
    name: `Resource ${index}`,
    description: '',
    actions: ['VIEW', 'USE'],
    publishedVersion: index + 1,
    source: index === 0 ? 'PERSONAL' : 'ORGANIZATION',
  }));
  const fetchImpl = async (url: string | URL | Request) => {
    const parsed = new URL(url.toString());
    requests.push(parsed.pathname + parsed.search);
    const data = parsed.searchParams.get('page') === '1' ? firstPage : [{
      id: 'resource-30', name: 'Resource 30', description: '', actions: ['USE'],
      publishedVersion: 31, source: 'ORGANIZATION',
    }];
    return new Response(JSON.stringify({ code: 200, data }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new EnterpriseBackgroundClient('http://127.0.0.1:3580', 'a'.repeat(43), {
    id: '11111111-1111-4111-8111-111111111111',
    jobId: 'cron_12345678',
    secret: 'b'.repeat(64),
    userId: '17',
  }, fetchImpl as typeof fetch);

  const resources = await client.resources('SKILL') as Array<Record<string, unknown>>;

  expect(requests).toEqual([
    '/internal/rc2/background/grants/11111111-1111-4111-8111-111111111111/resources?type=SKILL&scope=available&page=1',
    '/internal/rc2/background/grants/11111111-1111-4111-8111-111111111111/resources?type=SKILL&scope=available&page=2',
  ]);
  expect(resources).toHaveLength(31);
  expect(resources[0]).toMatchObject({ id: 'resource-0', source: 'personal', version: 1, type: 'SKILL' });
  expect(resources.at(-1)).toMatchObject({ id: 'resource-30', source: 'enterprise', version: 31 });
});
