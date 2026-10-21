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
  expect(() => registry.verify('conversation-a', [{ ref, quote: '1' }])).toThrow('SOURCE_EVIDENCE_QUOTE_LENGTH_2_2000');
  expect(() => registry.verify('conversation-a', [{ ref, quote: 'x'.repeat(2001) }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_LENGTH_2_2000'
  );
});

test('offers and verifies short Chinese labels without weakening continuous matching', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'knowledge',
    text: '扫码\n二维码',
    locator: { page: 1 },
  });

  expect(registry.quoteOptions('conversation-a', ref)).toEqual([
    { index: 0, quote: '扫码' },
    { index: 1, quote: '二维码' },
  ]);
  expect(registry.verify('conversation-a', [{ ref, quoteIndex: 0 }])[0].quote).toBe('扫码');
  expect(() => registry.verify('conversation-a', [{ ref, quote: '扫码二维码' }])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_ABSENT'
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

test('offers at most 16 deterministic exact line segments and removes duplicates', () => {
  const registry = new SourceEvidenceRegistry();
  const longLine = 'L'.repeat(520);
  const repeated = 'Repeated candidate line, with punctuation.';
  const text = [
    longLine,
    repeated,
    repeated,
    ...Array.from({ length: 20 }, (_, index) => `Unique line ${index}.`),
  ].join('\n');
  const ref = registry.add('conversation-a', { kind: 'knowledge', text, locator: {} });

  const options = registry.quoteOptions('conversation-a', ref);

  expect(options).toHaveLength(16);
  expect(options.slice(0, 3)).toEqual([
    { index: 0, quote: 'L'.repeat(500) },
    { index: 1, quote: 'L'.repeat(20) },
    { index: 2, quote: repeated },
  ]);
  expect(new Set(options.map((option) => option.quote)).size).toBe(16);
});

test('verifies a zero-based quote index and returns the exact source substring', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'workspace',
    text: 'First available source line.\nExact,\tindexed quote!',
    locator: { paragraph: 2 },
  });

  expect(registry.verify('conversation-a', [{ ref, quoteIndex: 1 }])).toEqual([
    {
      ref,
      kind: 'workspace',
      locator: { paragraph: 2 },
      quote: 'Exact,\tindexed quote!',
    },
  ]);
});

test('rejects ambiguous, fractional, negative and out-of-range quote indexes', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'Only one candidate source line.',
    locator: {},
  });

  expect(() =>
    registry.verify('conversation-a', [{ ref, quote: 'Only one candidate', quoteIndex: 0 } as never])
  ).toThrow('SOURCE_EVIDENCE_REFERENCE_AMBIGUOUS');
  for (const quoteIndex of [-1, 0.5, 1]) {
    expect(() => registry.verify('conversation-a', [{ ref, quoteIndex }])).toThrow(
      'SOURCE_EVIDENCE_QUOTE_INDEX_INVALID'
    );
  }
});

test('reports the one-based position and safe reason for malformed reference entries', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'A valid source line for positional diagnostics.',
    locator: {},
  });
  const valid = { ref, quoteIndex: 0 };

  expect(() => registry.verify('conversation-a', [valid, { quoteIndex: 0 } as never])).toThrow(
    'SOURCE_EVIDENCE_REFERENCE_INVALID reference=2 reason=missing_ref'
  );
  expect(() =>
    registry.verify('conversation-a', [{ ref, quote: 'A valid source line', quoteIndex: 0 } as never])
  ).toThrow('SOURCE_EVIDENCE_REFERENCE_AMBIGUOUS reference=1 reason=quote_and_quoteIndex_both_present');
  expect(() => registry.verify('conversation-a', [{ ref } as never])).toThrow(
    'SOURCE_EVIDENCE_REFERENCE_INVALID reference=1 reason=missing_quote_or_quoteIndex'
  );
  expect(() => registry.verify('conversation-a', [valid, { ref, quoteIndex: '0' } as never])).toThrow(
    'SOURCE_EVIDENCE_QUOTE_INDEX_INVALID reference=2 reason=invalid_quoteIndex_type'
  );
});

test('reports the failing position for unavailable source references', () => {
  let now = 1_000;
  const registry = new SourceEvidenceRegistry(() => now);
  const expired = registry.add('conversation-a', {
    kind: 'knowledge',
    text: 'This source will expire before the live source.',
    locator: {},
  });
  now += 30 * 60 * 1000 - 1;
  const live = registry.add('conversation-a', {
    kind: 'knowledge',
    text: 'This source remains live for positional diagnostics.',
    locator: {},
  });
  const otherConversation = registry.add('conversation-b', {
    kind: 'knowledge',
    text: 'This source belongs to another conversation.',
    locator: {},
  });
  const valid = { ref: live, quoteIndex: 0 };

  expect(() => registry.verify('conversation-a', [valid, { ref: 'missing', quoteIndex: 0 }])).toThrow(
    'SOURCE_EVIDENCE_REF_MISSING reference=2 reason=ref_missing'
  );
  expect(() => registry.verify('conversation-a', [valid, { ref: otherConversation, quoteIndex: 0 }])).toThrow(
    'SOURCE_EVIDENCE_CROSS_CONVERSATION reference=2 reason=cross_conversation'
  );
  now += 1;
  expect(() => registry.verify('conversation-a', [valid, { ref: expired, quoteIndex: 0 }])).toThrow(
    'SOURCE_EVIDENCE_EXPIRED reference=2 reason=expired'
  );
});

test('keeps separate short lines as separate quote options', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'knowledge',
    text: 'short\nlines\nonly',
    locator: {},
  });

  expect(registry.quoteOptions('conversation-a', ref)).toEqual([
    { index: 0, quote: 'short' },
    { index: 1, quote: 'lines' },
    { index: 2, quote: 'only' },
  ]);
});

test('applies missing and cross-conversation checks to quote options', () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add('conversation-a', {
    kind: 'web',
    text: 'Conversation ownership remains enforced.',
    locator: {},
  });

  expect(() => registry.quoteOptions('conversation-a', 'missing')).toThrow('SOURCE_EVIDENCE_REF_MISSING');
  expect(() => registry.quoteOptions('conversation-b', ref)).toThrow('SOURCE_EVIDENCE_CROSS_CONVERSATION');
});

test('rejects expired quote options and globally prunes before reporting sources', () => {
  let now = 7_000;
  const registry = new SourceEvidenceRegistry(() => now);
  const first = registry.add('conversation-a', {
    kind: 'web',
    text: 'Expired source line for direct lookup.',
    locator: {},
  });
  registry.add('conversation-b', {
    kind: 'knowledge',
    text: 'Expired source line in an abandoned conversation.',
    locator: {},
  });
  now += 30 * 60 * 1000;

  expect(() => registry.quoteOptions('conversation-a', first)).toThrow('SOURCE_EVIDENCE_EXPIRED');
  expect(registry.hasSources('conversation-b')).toBe(false);
});

test("separates wide-space PDF columns without inventing a joined source sentence", () => {
  const registry = new SourceEvidenceRegistry();
  const ref = registry.add("c", {
    kind: "workspace",
    text: "实现产废数据全过程的收集、存储与管理。                                      质量管理/数据分析",
    locator: { path: "proposal.pdf", version: 1, physicalPage: 5 },
  });
  const options = registry.quoteOptions("c", ref);
  expect(options.map((item) => item.quote)).toEqual([
    "实现产废数据全过程的收集、存储与管理。",
    "质量管理/数据分析",
  ]);
  expect(registry.verify("c", [{ ref, quoteIndex: 0 }])[0].quote).toBe(
    "实现产废数据全过程的收集、存储与管理。",
  );
});
