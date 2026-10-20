import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), body: '', options: {} as Record<string,unknown> }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { readWeb, searchWeb } from './research.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.body = '<html><title>Official facts</title><p>Original source description and evidence.</p></html>';
  mocks.request.mockImplementation((_url, options, callback) => {
    mocks.options = options;
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'text/html' }, destroy() {} });
      callback(res); res.emit('data', Buffer.from(mocks.body)); res.emit('end');
    });
    return req;
  });
});
test('pins one public IPv4 with an explicit family compatible with Node 24 lookup', async () => {
  await expect(readWeb('https://example.com/source')).resolves.toMatchObject({ title: 'Official facts' });
  expect(mocks.options.family).toBe(4);
  const callback = vi.fn();
  (mocks.options.lookup as Function)('example.com', { family: 4 }, callback);
  expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
});
test('does not present an HTTP 200 access challenge as research evidence', async () => {
  mocks.body = '<title>Your request has been blocked</title><p>Try again later</p>';
  await expect(readWeb('https://example.com/source')).rejects.toThrow('WEB_ACCESS_CHALLENGE');
});
test('refuses a private DNS result before opening a connection', async () => {
  mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  await expect(readWeb('https://example.com/source')).rejects.toThrow('PRIVATE_DESTINATION_DENIED');
  expect(mocks.request).not.toHaveBeenCalled();
});

test('keeps search provider dates separate from original publication dates', async () => {
  mocks.body = '<rss><item><title>Article</title><link>https://example.com/source</link><description>Lead</description><pubDate>20 Oct 2026</pubDate></item></rss>';
  const found = await searchWeb('office AI');
  expect((found.results as Array<Record<string,unknown>>)[0]).toMatchObject({ publishedAt: null, providerDate: '20 Oct 2026' });
});
test('reads explicitly identified article metadata without executing webpage scripts', async () => {
  mocks.body = '<title>Source</title><meta content="Official overview" name="description"><script type="application/ld+json">{"articleBody":"Original documented capabilities", "description":"Declared summary", "datePublished":"2026-01-02"}</script><script>throw Error("never execute")</script>';
  const source = await readWeb('https://example.com/source');
  expect(source.publishedAt).toBe('2026-01-02');
  expect(source.text).toContain('Original documented capabilities');
  expect(source.text).toContain('Official overview');
  expect(source.text).not.toContain('never execute');
  expect(source.textSources).toMatchObject({ metadataDescription: true, structuredArticle: true });
});
