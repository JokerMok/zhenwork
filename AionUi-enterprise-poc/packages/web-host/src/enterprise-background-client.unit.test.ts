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

test('task knowledge supports fixed versions and rejects unrelated routes, writes and credential overrides', async () => {
  const calls: Array<{url:string;headers:HeadersInit|undefined}>=[];
  const client=new EnterpriseBackgroundClient('http://127.0.0.1:3580','a'.repeat(43),{id:'11111111-1111-4111-8111-111111111111',jobId:'task_12345678',secret:'b'.repeat(64),userId:'17'},async(url,init)=>{
    calls.push({url:String(url),headers:init?.headers});return new Response(JSON.stringify({code:200,data:{version:2}}));
  });
  const document='22222222-2222-4222-8222-222222222222';
  const result=await client.request(`/ai/knowledge/documents/${document}/versions/2`,{headers:{Authorization:'untrusted',Cookie:'untrusted'}});
  expect(result.body?.data).toEqual({version:2});
  expect(calls[0].url).toContain(`/knowledge/documents/${document}/versions/2`);
  expect(new Headers(calls[0].headers).get('Authorization')).toBe('Bearer '+'a'.repeat(43));
  expect(new Headers(calls[0].headers).has('Cookie')).toBe(false);
  await expect(client.request('/system/user/list')).rejects.toThrow('Background route denied');
  await expect(client.request(`/ai/knowledge/documents/${document}/versions/2`,{method:'DELETE'})).rejects.toThrow('read only');
});

test('background calculator has an exact read-only route and never forwards browser credentials', async () => {
  const calls: Array<{url:string;init?:RequestInit}>=[];
  const client=new EnterpriseBackgroundClient('http://127.0.0.1:3580','a'.repeat(43),{id:'11111111-1111-4111-8111-111111111111',jobId:'task_12345678',secret:'b'.repeat(64),userId:'17'},async(url,init)=>{
    calls.push({url:String(url),init});return new Response(JSON.stringify({code:200,data:{value:'0.3'}}));
  });
  const id='22222222-2222-4222-8222-222222222222';
  const result=await client.request(`/ai/tools/${id}/calculate`,{method:'POST',headers:{Authorization:'untrusted',Cookie:'untrusted'},body:JSON.stringify({operation:'add',a:'0.1',b:'0.2'})});
  expect(result.body?.data).toEqual({value:'0.3'});
  expect(calls[0].url).toContain(`/tools/${id}/calculate`);
  expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer '+'a'.repeat(43));
  expect(new Headers(calls[0].init?.headers).has('Cookie')).toBe(false);
  await expect(client.request(`/ai/tools/${id}/execute`,{method:'POST',body:'{}'})).rejects.toThrow('read only');
  await expect(client.request(`/ai/tools/${id}/calculate?url=untrusted`,{method:'POST',body:'{}'})).rejects.toThrow('read only');
});
