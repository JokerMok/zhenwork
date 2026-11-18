import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  body: '',
  bodies: [] as string[],
  options: {} as Record<string, unknown>,
}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { readWeb, searchWeb, selectWebText } from './research.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mocks.body = '<html><title>Official facts</title><p>Original source description and evidence.</p></html>';
  mocks.bodies = [];
  mocks.request.mockImplementation((_url, options, callback) => {
    mocks.options = options;
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          destroy() {},
        });
        callback(res);
        res.emit('data', Buffer.from(mocks.bodies.shift() ?? mocks.body));
        res.emit('end');
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
  mocks.body =
    '<rss><item><title>Article</title><link>https://example.com/source</link><description>Lead</description><pubDate>20 Oct 2026</pubDate></item></rss>';
  const found = await searchWeb('office AI');
  expect((found.results as Array<Record<string, unknown>>)[0]).toMatchObject({
    publishedAt: null,
    providerDate: '20 Oct 2026',
  });
});

test('uses one naturalized fallback and preserves the original site constraint', async () => {
  mocks.bodies = [
    '<rss><item><title>Knowledge dictionary</title><link>https://dictionary.example/knowledge</link><description>Knowledge definition</description></item></rss>',
    '<rss><item><title>Dify Knowledge Pipeline</title><link>https://docs.dify.ai/knowledge/pipeline</link><description>Official guide</description></item><item><title>Unrelated copy</title><link>https://example.com/dify</link><description>Knowledge Pipeline</description></item></rss>',
  ];
  const found = await searchWeb('site:dify.ai "Knowledge Pipeline"');
  expect(found).toMatchObject({ fallbackUsed: true, fallbackQuery: 'dify.ai Knowledge Pipeline' });
  expect((found.results as Array<Record<string, unknown>>).map((item) => item.url)).toEqual([
    'https://docs.dify.ai/knowledge/pipeline',
  ]);
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

test('does not add a fallback request for a query without operators', async () => {
  mocks.body =
    '<rss><item><title>Dify Knowledge Pipeline</title><link>https://dify.ai/</link><description>Official page</description></item></rss>';
  const found = await searchWeb('Dify Knowledge Pipeline');
  expect(found).toMatchObject({ fallbackUsed: false, executedQueries: ['Dify Knowledge Pipeline'] });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});
test('reads explicitly identified article metadata without executing webpage scripts', async () => {
  mocks.body =
    '<title>Source</title><meta content="Official overview" name="description"><main>Semantic HTML body</main><script type="application/ld+json">{"articleBody":"Original documented capabilities", "description":"Declared summary", "datePublished":"2026-01-02"}</script><script>throw Error("never execute")</script>';
  const source = await readWeb('https://example.com/source');
  expect(source.publishedAt).toBe('2026-01-02');
  expect(source.text).toMatch(/^Original documented capabilities\nSemantic HTML body/);
  expect(source.text).toContain('Official overview');
  expect(source.text).not.toContain('never execute');
  expect(source.textSources).toMatchObject({ metadataDescription: true, structuredArticle: true });
});

test('extracts publication metadata from a headline-only Article and separates its update date', async () => {
  mocks.body =
    '<main><h1>Official release</h1><p>Original release details.</p></main><script type="application/ld+json">{"@type":"BlogPosting","headline":"Official release","datePublished":"2025-09-23","dateModified":"2026-01-02"}</script>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({
    publishedAt: '2025-09-23',
    modifiedAt: '2026-01-02',
    publicationDateStatus: 'identified',
  });
  expect(source.publicationDateEvidence).toEqual([{ value: '2025-09-23', source: 'jsonld.datePublished' }]);
});

test('reads JSON-LD date declarations with ordinary HTML attribute whitespace', async () => {
  mocks.body =
    '<main><h1>Release</h1><p>Release details.</p></main><script TYPE = "application/ld+json">{"@type":"Article","datePublished":"2025-09-23"}</script><script>throw Error("must not execute")</script>';
  expect(await readWeb('https://example.com/source')).toMatchObject({
    publishedAt: '2025-09-23',
    publicationDateStatus: 'identified',
  });
});

test('preserves an article header and extracts its explicitly labelled publication time', async () => {
  mocks.body =
    '<header>Global navigation</header><article><header><h1>Official release</h1><p>Published <time datetime="2025-09-23">September 23, 2025</time></p></header><p>Original release details.</p></article>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: '2025-09-23', publicationDateStatus: 'identified' });
  expect(source.text).toContain('September 23, 2025');
  expect(source.text).not.toContain('Global navigation');
});

test('does not turn an updated-only page or an unlabelled time into a publication date', async () => {
  mocks.body =
    '<article><header><h1>Current guide</h1><p>Last updated <time datetime="2026-01-02">January 2, 2026</time></p><time datetime="2025-09-23">September 23, 2025</time></header><p>Guide content.</p></article>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: null, modifiedAt: '2026-01-02', publicationDateStatus: 'not_extracted' });
  expect(source.publicationDateEvidence).toEqual([]);
  expect(source.publicationDateNote).toContain('does not establish that the original page has no publication date');
});

test('does not borrow dates from Product metadata, ItemList entries or another article URL', async () => {
  mocks.body =
    '<main><h1>Current guide</h1><p>Current guide content.</p></main><script type="application/ld+json">{"@graph":[{"@type":"Product","description":"Promotional metadata","datePublished":"2025-01-02"},{"@type":"ItemList","itemListElement":[{"@type":"Article","datePublished":"2025-02-03"}]},{"@type":"BlogPosting","url":"https://example.com/other-article","description":"Related article","datePublished":"2025-03-04"}]}</script>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: null, publicationDateStatus: 'not_extracted' });
  expect(source.publicationDateEvidence).toEqual([]);
});

test('reports conflicting original publication declarations instead of choosing an arbitrary date', async () => {
  mocks.body =
    '<meta property="article:published_time" content="2025-09-23"><main><h1>Release</h1><p>Release details.</p></main><script type="application/ld+json">{"@type":"Article","datePublished":"2025-09-24"}</script>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: null, publicationDateStatus: 'conflicting' });
  expect(source.publicationDateEvidence).toHaveLength(2);
});

test('accepts matching date-only and timestamp declarations without inventing a conflict', async () => {
  mocks.body =
    '<meta property="article:published_time" content="2025-09-23T10:00:00+08:00"><article><header><h1>Release</h1><time itemprop="datePublished" datetime="2025-09-23">September 23, 2025</time></header><p>Release details.</p></article>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: '2025-09-23T10:00:00+08:00', publicationDateStatus: 'identified' });
});

test('does not infer publication from a generic date, footer year, or historical body date', async () => {
  mocks.body =
    '<meta name="date" content="2026-01-02"><main><h1>History</h1><p>The earlier announcement was on 2025-09-23.</p></main><footer>Copyright 2026</footer>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: null, publicationDateStatus: 'not_extracted' });
});

test('does not assign a related article time to the current article', async () => {
  mocks.body =
    '<main><article><h1>Current guide</h1><p>Current guide content.</p></article><article><h2>Related release</h2><time itemprop="datePublished" datetime="2025-09-23">September 23, 2025</time></article></main>';
  const source = await readWeb('https://example.com/source');
  expect(source).toMatchObject({ publishedAt: null, publicationDateStatus: 'not_extracted' });
});

test('keeps multiple unidentified Article dates ambiguous but selects an explicitly matching page identity', async () => {
  mocks.bodies = [
    '<main><h1>Current guide</h1><p>Guide content.</p></main><script type="application/ld+json">{"@graph":[{"@type":"Article","datePublished":"2025-09-23"},{"@type":"Article","datePublished":"2025-09-24"}]}</script>',
    '<main><h1>Current guide</h1><p>Guide content.</p></main><script type="application/ld+json">{"@graph":[{"@type":"Article","url":"https://example.com/other","datePublished":"2025-09-23"},{"@type":"Article","@id":"https://example.com/source#article","datePublished":"2025-09-24"}]}</script>',
  ];
  expect(await readWeb('https://example.com/source')).toMatchObject({
    publishedAt: null,
    publicationDateStatus: 'conflicting',
  });
  expect(await readWeb('https://example.com/source')).toMatchObject({
    publishedAt: '2025-09-24',
    publicationDateStatus: 'identified',
  });
});

test('keeps Chinese publication and update labels distinct', async () => {
  mocks.body =
    '<article><header><h1>官方指南</h1><p>发布时间：<time datetime="2025-09-23">2025年9月23日</time></p><p>更新于：<time datetime="2026-01-02">2026年1月2日</time></p></header><p>指南正文。</p></article>';
  expect(await readWeb('https://example.com/source')).toMatchObject({
    publishedAt: '2025-09-23',
    modifiedAt: '2026-01-02',
    publicationDateStatus: 'identified',
  });
});

test('does not normalize an impossible declared date into a different calendar date', async () => {
  mocks.body =
    '<meta property="article:published_time" content="2025-02-30"><main><h1>Release</h1><p>Release details.</p></main>';
  expect(await readWeb('https://example.com/source')).toMatchObject({
    publishedAt: null,
    publicationDateStatus: 'not_extracted',
  });
});

test('places semantic main content before long navigation and removes page chrome', async () => {
  const navigation = Array.from({ length: 24 }, (_, index) => `<li>Navigation item ${index}</li>`).join('');
  mocks.body = `<html><head><title>Official product</title></head><body><header>Global promotion</header><nav><ul>${navigation}</ul></nav><div role="main"><section><div><h1>Documented capability</h1><p>The product supports a continuous, source-backed workflow.</p></div></section></div><aside>Related promotion</aside><footer>Legal links</footer></body></html>`;
  const source = await readWeb('https://example.com/source');
  expect(source.text).toBe('Documented capability\nThe product supports a continuous, source-backed workflow.');
  expect(source.contentSelection).toBe('semantic_html');
  expect(source.textSources).toMatchObject({ semanticHtml: true, htmlFallback: false });
});

test('uses cleaned HTML as an explicit fallback when no semantic body exists', async () => {
  mocks.body =
    '<html><head><title>Fallback page</title></head><body><nav>Menu noise</nav><div><h2>Fallback heading</h2><p>Original fallback content remains available.</p></div><footer>Footer noise</footer></body></html>';
  const source = await readWeb('https://example.com/source');
  expect(source.text).toBe('Fallback heading\nOriginal fallback content remains available.');
  expect(source.contentSelection).toBe('html_fallback');
  expect(source.evidence).toContain('No semantic article/main body was available');
});

test('does not treat a JSON-LD description as structured article body', async () => {
  mocks.body =
    '<script type="application/ld+json">{"@type":"Product","description":"Promotional metadata summary only"}</script>';
  const source = await readWeb('https://example.com/source');
  expect(source.text).toBe('Promotional metadata summary only');
  expect(source.contentSelection).toBe('metadata_only');
  expect(source.textSources).toMatchObject({ structuredArticle: false, structuredDescription: true });
  expect(source.limitedText).toBe(true);
});

test('bounds malformed repeated semantic blocks and falls back without rescanning', async () => {
  mocks.body = Array.from({ length: 5_000 }, () => '<main>Unclosed semantic content').join('');
  const source = await readWeb('https://example.com/source');
  expect(source.contentSelection).toBe('html_fallback');
  expect((source.text as string).length).toBe(45_000);
  expect(source.truncated).toBe(true);
  expect(source.evidence).toContain('No semantic article/main body was available');
});

test('reads a real long-page tail by exact query or pagination without inventing whole-page coverage', async () => {
  mocks.body = '<main><p>' + '前文'.repeat(30000) + '</p><p>第一千二百四十二条 生效与废止原文。</p></main>';
  const initial = await readWeb('https://example.com/source');
  expect(initial.text).not.toContain('生效与废止');
  const tail = await readWeb('https://example.com/source', undefined, { query: '第一千二百四十二条', maxChars: 1000 });
  expect(tail.text).toContain('生效与废止原文');
  expect(Number(tail.start)).toBeGreaterThan(45000);
  expect(tail.fullTextSha256).toBe(initial.fullTextSha256);
  expect(tail.sha256).not.toBe(initial.sha256);
  const next = await readWeb('https://example.com/source', undefined, { start: Number(initial.nextStart) });
  expect(next.text).toContain('生效与废止原文');
  expect(selectWebText('原文', { query: '不存在' })).toMatchObject({
    status: 'no_match',
    text: '',
    matches: [],
    totalChars: 2,
  });
  expect(() => selectWebText('原文', { start: -1 })).toThrow('WEB_READ_WINDOW_INVALID');
});

test('rejects a soft-404 destination despite HTTP200 before issuing source evidence', async () => {
  await expect(readWeb('https://example.com/404/index.html')).rejects.toThrow('WEB_SOURCE_NOT_FOUND');
});

test('a literal miss on a fetched page is no-match data without fabricated evidence', async () => {
  mocks.body = '<main><p>Actual original statement.</p></main>';
  const result = await readWeb('https://example.com/source', undefined, { query: 'invented phrase' });
  expect(result).toMatchObject({ status: 'no_match', text: '', matches: [] });
  expect(result).not.toHaveProperty('sourceRef');
});

test('exact lookup starts at its own original paragraph rather than a previous article', () => {
  const text = '前一条完全无关的内容。\n目标条文 这里是所需原文。\n后续条文。';
  const result = selectWebText(text, { query: '目标条文', maxChars: 1000 });
  expect(result.text.startsWith('目标条文')).toBe(true);
  expect(text.slice(result.start, result.end)).toBe(result.text);
});
