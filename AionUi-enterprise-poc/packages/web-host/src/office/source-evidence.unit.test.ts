import { expect, test } from 'vitest';

import { SourceEvidenceRegistry } from './source-evidence.js';

test('returns only a continuous quote after collapsing Unicode whitespace', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'The policy\t\n requires\u00a0manager approval before release.',
    locator: { url: 'https://example.com/policy', section: { heading: 'Release' } },
  });

  expect(registry.verify('conversation-a', [{ ref, quote: 'policy requires\n manager approval' }])).toEqual([
    {
      ref,
      kind: 'web',
      locator: { url: 'https://example.com/policy', section: { heading: 'Release' } },
      quote: 'policy requires manager approval',
    },
  ]);
});

test('keeps locator data isolated from caller mutations', () => {
  const registry = new SourceEvidenceRegistry();
  const locator = { path: '/workspace/report.docx', position: { paragraph: 4 } };
  const ref = registry.add('conversation-a', {
    kind: 'workspace',
    text: 'Approved source text remains unchanged.',
    locator,
  });
  locator.position.paragraph = 99;

  const first = registry.verify('conversation-a', [{ ref, quote: 'source text remains' }]);
  (first[0].locator as { position: { paragraph: number } }).position.paragraph = 55;
  const second = registry.verify('conversation-a', [{ ref, quote: 'source text remains' }]);

  expect(second[0].locator).toEqual({ path: '/workspace/report.docx', position: { paragraph: 4 } });
});

test('does not ignore punctuation, case or gaps when matching quotes', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'knowledge',
    text: 'Alpha, beta; gamma is the verified statement.',
    locator: { article: 'policy' },
  });

  expect(() => registry.verify('conversation-a', [{ ref, quote: 'alpha, beta' }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_ABSENT'
  );
  expect(() => registry.verify('conversation-a', [{ ref, quote: 'Alpha beta' }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_ABSENT'
  );
  expect(() => registry.verify('conversation-a', [{ ref, quote: 'Alpha, gamma' }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_ABSENT'
  );
});

test('rejects invalid reference counts and quote lengths', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'A sufficiently long piece of source text.',
    locator: {},
  });

  expect(() => registry.verify('conversation-a', [])).toThrow('SOURCE_EVIDENCE_REFS_LIMIT_1_32');
  expect(() =>
    registry.verify(
      'conversation-a',
      Array.from({ length: 33 }, () => ({ ref, quote: 'long enough' }))
    )
  ).toThrow('SOURCE_EVIDENCE_REFS_LIMIT_1_32');
  expect(() => registry.verify('conversation-a', [{ ref, quote: '1234567' }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_LENGTH_8_2000'
  );
  expect(() => registry.verify('conversation-a', [{ ref, quote: 'x'.repeat(2001) }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_LENGTH_8_2000'
  );
});

test('distinguishes missing references from cross-conversation access', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'Evidence belongs to its original conversation.',
    locator: {},
  });

  expect(() => registry.verify('conversation-a', [{ ref: 'missing', quote: 'long enough' }])).toThrow(
    'SOURCE_EVIDENCE_REF_MISSING'
  );
  expect(() => registry.verify('conversation-b', [{ ref, quote: 'Evidence belongs' }])).toThrow(
    'SOURCE_EVIDENCE_CROSS_CONVERSATION'
  );
});

test('expires references at the fixed thirty-minute boundary', () => {
  let now = 1_000;
  const registry = new SourceEvidenceRegistry(() => now);
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'Evidence remains available before expiry.',
    locator: {},
  });
  now += 30 * 60 * 1000 - 1;
  expect(registry.verify('conversation-a', [{ ref, quote: 'Evidence remains' }])).toHaveLength(1);

  now += 1;
  expect(() => registry.verify('conversation-a', [{ ref, quote: 'Evidence remains' }])).toThrow(
    'SOURCE_EVIDENCE_EXPIRED'
  );
});

test('evicts the oldest source when a conversation exceeds 64 sources', () => {
  const registry = new SourceEvidenceRegistry();
  const refs = Array.from({ length: 65 }, (_, index) =>
    registry.add('conversation-a', {
      kind: 'workspace',
      text: `Source number ${index.toString().padStart(2, '0')} remains available.`,
      locator: { index },
    })
  );

  expect(() => registry.verify('conversation-a', [{ ref: refs[0], quote: 'Source number 00' }])).toThrow(
    'SOURCE_EVIDENCE_REF_MISSING'
  );
  expect(registry.verify('conversation-a', [{ ref: refs[64], quote: 'Source number 64' }])).toHaveLength(1);
});

test('counts UTF-8 bytes globally and evicts the oldest source across conversations', () => {
  const registry = new SourceEvidenceRegistry();
  const first = registry.add('conversation-a', {
    kind: 'knowledge',
    text: '😀'.repeat(300_000),
    locator: { index: 1 },
  });
  const second = registry.add('conversation-b', {
    kind: 'knowledge',
    text: '界'.repeat(400_000),
    locator: { index: 2 },
  });

  expect(() => registry.verify('conversation-a', [{ ref: first, quote: '😀'.repeat(8) }])).toThrow(
    'SOURCE_EVIDENCE_REF_MISSING'
  );
  expect(registry.verify('conversation-b', [{ ref: second, quote: '界'.repeat(8) }])).toHaveLength(1);
});

test('evicts the globally oldest source after 128 sources across conversations', () => {
  const registry = new SourceEvidenceRegistry();
  const refs = Array.from({ length: 129 }, (_, index) =>
    registry.add(`conversation-${Math.floor(index / 64)}`, {
      kind: 'workspace',
      text: `Global source ${index.toString().padStart(3, '0')} remains available.`,
      locator: { index },
    })
  );

  expect(() => registry.verify('conversation-0', [{ ref: refs[0], quote: 'Global source 000' }])).toThrow(
    'SOURCE_EVIDENCE_REF_MISSING'
  );
  expect(registry.verify('conversation-2', [{ ref: refs[128], quote: 'Global source 128' }])).toHaveLength(1);
});

test('prunes expired evidence from abandoned conversations when adding elsewhere', () => {
  let now = 5_000;
  const registry = new SourceEvidenceRegistry(() => now);
  const expired = registry.add('abandoned-conversation', {
    kind: 'web',
    text: 'Abandoned evidence expires without another access.',
    locator: {},
  });
  now += 30 * 60 * 1000;

  registry.add('active-conversation', {
    kind: 'web',
    text: 'A new source triggers global expiry pruning.',
    locator: {},
  });

  expect(() =>
    registry.verify('abandoned-conversation', [{ ref: expired, quote: 'Abandoned evidence expires' }])
  ).toThrow('SOURCE_EVIDENCE_REF_MISSING');
});

test('rejects one oversized source without evicting existing evidence', () => {
  const registry = new SourceEvidenceRegistry();
  const first = registry.add('conversation-a', {
    kind: 'web',
    text: 'Existing evidence remains after a rejected add.',
    locator: {},
  });

  expect(() =>
    registry.add('conversation-a', {
      kind: 'web',
      text: 'x'.repeat(2 * 1024 * 1024 + 1),
      locator: {},
    })
  ).toThrow('SOURCE_EVIDENCE_SOURCE_LIMIT_2MB');
  expect(registry.verify('conversation-a', [{ ref: first, quote: 'Existing evidence remains' }])).toHaveLength(1);
});
