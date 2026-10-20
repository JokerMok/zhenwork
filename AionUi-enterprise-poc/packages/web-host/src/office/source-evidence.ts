import { randomUUID } from 'node:crypto';

export type SourceEvidenceKind = 'web' | 'knowledge' | 'workspace';

export type SourceEvidenceInput = {
  kind: SourceEvidenceKind;
  text: string;
  locator: unknown;
};

export type SourceEvidenceReference =
  | { ref: string; quote: string; quoteIndex?: never }
  | { ref: string; quote?: never; quoteIndex: number };

export type SourceEvidenceQuoteOption = {
  index: number;
  quote: string;
};

export type VerifiedSourceEvidence = {
  ref: string;
  kind: SourceEvidenceKind;
  locator: unknown;
  quote: string;
};

type StoredSourceEvidence = {
  ref: string;
  kind: SourceEvidenceKind;
  text: string;
  locator: unknown;
  byteSize: number;
  expiresAt: number;
};

type ConversationSources = {
  entries: Map<string, StoredSourceEvidence>;
  totalBytes: number;
};

const MAX_SOURCES_PER_CONVERSATION = 64;
const MAX_SOURCES_TOTAL = 128;
const MAX_SOURCE_BYTES_TOTAL = 2 * 1024 * 1024;
const SOURCE_TTL_MS = 30 * 60 * 1000;
const MAX_REFERENCES = 32;
const MIN_QUOTE_LENGTH = 2;
const MAX_QUOTE_LENGTH = 2000;
const MAX_QUOTE_OPTIONS = 16;
const MAX_QUOTE_OPTION_LENGTH = 500;

type ReferenceFailureReason =
  | 'missing_ref'
  | 'invalid_ref_type'
  | 'empty_ref'
  | 'quote_and_quoteIndex_both_present'
  | 'missing_quote_or_quoteIndex'
  | 'invalid_quote_type'
  | 'invalid_quoteIndex_type'
  | 'invalid_quoteIndex_range'
  | 'quote_length_out_of_range'
  | 'quote_absent'
  | 'ref_missing'
  | 'cross_conversation'
  | 'expired'
  | 'locator_invalid'
  | 'validation_failed';

class ReferenceValidationError extends Error {
  constructor(
    code: string,
    readonly reason: ReferenceFailureReason
  ) {
    super(code);
  }
}

const REFERENCE_ERROR_REASONS: Readonly<Record<string, ReferenceFailureReason>> = {
  SOURCE_EVIDENCE_REFERENCE_INVALID: 'validation_failed',
  SOURCE_EVIDENCE_REFERENCE_AMBIGUOUS: 'quote_and_quoteIndex_both_present',
  SOURCE_EVIDENCE_QUOTE_INDEX_INVALID: 'invalid_quoteIndex_range',
  SOURCE_EVIDENCE_QUOTE_LENGTH_2_2000: 'quote_length_out_of_range',
  SOURCE_EVIDENCE_QUOTE_ABSENT: 'quote_absent',
  SOURCE_EVIDENCE_REF_MISSING: 'ref_missing',
  SOURCE_EVIDENCE_CROSS_CONVERSATION: 'cross_conversation',
  SOURCE_EVIDENCE_EXPIRED: 'expired',
  SOURCE_EVIDENCE_LOCATOR_INVALID: 'locator_invalid',
};

function failReference(code: string, reason: ReferenceFailureReason): never {
  throw new ReferenceValidationError(code, reason);
}

function indexedReferenceError(error: unknown, index: number): Error {
  if (error instanceof ReferenceValidationError) {
    return new Error(`${error.message} reference=${index + 1} reason=${error.reason}`);
  }
  if (error instanceof Error && Object.hasOwn(REFERENCE_ERROR_REASONS, error.message)) {
    return new Error(`${error.message} reference=${index + 1} reason=${REFERENCE_ERROR_REASONS[error.message]}`);
  }
  return new Error(`SOURCE_EVIDENCE_REFERENCE_INVALID reference=${index + 1} reason=validation_failed`);
}

function normalizeQuote(value: string): string {
  return value.replace(/\p{White_Space}+/gu, ' ').trim();
}

function cloneLocator(locator: unknown): unknown {
  try {
    return structuredClone(locator);
  } catch {
    throw new Error('SOURCE_EVIDENCE_LOCATOR_INVALID');
  }
}

function validConversation(conversation: unknown): conversation is string {
  return typeof conversation === 'string' && conversation.length > 0;
}

function quoteOptionsFor(text: string): SourceEvidenceQuoteOption[] {
  const seen = new Set<string>();
  const quotes: string[] = [];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line.length < MIN_QUOTE_LENGTH) continue;
    for (let start = 0; start < line.length && quotes.length < MAX_QUOTE_OPTIONS; start += MAX_QUOTE_OPTION_LENGTH) {
      const quote = line.slice(start, start + MAX_QUOTE_OPTION_LENGTH);
      if (quote.length < MIN_QUOTE_LENGTH || seen.has(quote)) continue;
      seen.add(quote);
      quotes.push(quote);
    }
    if (quotes.length >= MAX_QUOTE_OPTIONS) break;
  }
  return quotes.map((quote, index) => ({ index, quote }));
}

/**
 * Keeps short-lived source text for exact quote provenance checks.
 *
 * This registry does not authorize access or establish semantic correctness.
 * Callers must re-check access control before using a verified locator.
 */
export class SourceEvidenceRegistry {
  private readonly conversations = new Map<string, ConversationSources>();
  private readonly owners = new Map<string, string>();
  private readonly insertionOrder = new Map<string, string>();
  private totalBytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  add(conversation: string, source: SourceEvidenceInput): string {
    if (!validConversation(conversation)) throw new Error('SOURCE_EVIDENCE_CONVERSATION_INVALID');
    if (!source || !['web', 'knowledge', 'workspace'].includes(source.kind) || typeof source.text !== 'string') {
      throw new Error('SOURCE_EVIDENCE_SOURCE_INVALID');
    }

    const byteSize = Buffer.byteLength(source.text, 'utf8');
    if (byteSize > MAX_SOURCE_BYTES_TOTAL) {
      throw new Error('SOURCE_EVIDENCE_SOURCE_LIMIT_2MB');
    }
    const locator = cloneLocator(source.locator);
    const currentTime = this.now();
    this.pruneExpired(currentTime);

    const bucket = this.conversations.get(conversation) ?? { entries: new Map(), totalBytes: 0 };
    while (bucket.entries.size >= MAX_SOURCES_PER_CONVERSATION) {
      const oldestRef = bucket.entries.keys().next().value as string | undefined;
      if (!oldestRef) break;
      this.remove(conversation, oldestRef, bucket);
    }
    while (this.insertionOrder.size >= MAX_SOURCES_TOTAL || this.totalBytes + byteSize > MAX_SOURCE_BYTES_TOTAL) {
      const oldest = this.insertionOrder.entries().next().value as [string, string] | undefined;
      if (!oldest) break;
      const [oldestRef, oldestConversation] = oldest;
      const oldestBucket = this.conversations.get(oldestConversation);
      if (oldestBucket) this.remove(oldestConversation, oldestRef, oldestBucket);
      else {
        this.insertionOrder.delete(oldestRef);
        this.owners.delete(oldestRef);
      }
    }
    this.conversations.set(conversation, bucket);

    let ref = randomUUID();
    while (this.owners.has(ref)) ref = randomUUID();
    bucket.entries.set(ref, {
      ref,
      kind: source.kind,
      text: source.text,
      locator,
      byteSize,
      expiresAt: currentTime + SOURCE_TTL_MS,
    });
    bucket.totalBytes += byteSize;
    this.totalBytes += byteSize;
    this.owners.set(ref, conversation);
    this.insertionOrder.set(ref, conversation);
    return ref;
  }

  hasSources(conversation: string): boolean {
    if (!validConversation(conversation)) throw new Error('SOURCE_EVIDENCE_CONVERSATION_INVALID');
    this.pruneExpired(this.now());
    return Boolean(this.conversations.get(conversation)?.entries.size);
  }

  /** Returns exact source substrings; callers still own ACL and relevance checks. */
  quoteOptions(conversation: string, ref: string): SourceEvidenceQuoteOption[] {
    if (!validConversation(conversation)) throw new Error('SOURCE_EVIDENCE_CONVERSATION_INVALID');
    if (typeof ref !== 'string' || ref.length === 0) throw new Error('SOURCE_EVIDENCE_REFERENCE_INVALID');
    return quoteOptionsFor(this.sourceFor(conversation, ref, this.now()).text);
  }

  verify(conversation: string, references: SourceEvidenceReference[]): VerifiedSourceEvidence[] {
    if (!validConversation(conversation)) throw new Error('SOURCE_EVIDENCE_CONVERSATION_INVALID');
    if (!Array.isArray(references) || references.length < 1 || references.length > MAX_REFERENCES) {
      throw new Error('SOURCE_EVIDENCE_REFS_LIMIT_1_32');
    }

    const currentTime = this.now();
    return references.map((reference, index) => {
      try {
        if (!reference || typeof reference !== 'object') {
          failReference('SOURCE_EVIDENCE_REFERENCE_INVALID', 'invalid_ref_type');
        }
        if (!Object.hasOwn(reference, 'ref')) {
          failReference('SOURCE_EVIDENCE_REFERENCE_INVALID', 'missing_ref');
        }
        if (typeof reference.ref !== 'string') {
          failReference('SOURCE_EVIDENCE_REFERENCE_INVALID', 'invalid_ref_type');
        }
        if (reference.ref.length === 0) {
          failReference('SOURCE_EVIDENCE_REFERENCE_INVALID', 'empty_ref');
        }
        const quoteProvided = Object.hasOwn(reference, 'quote');
        const indexProvided = Object.hasOwn(reference, 'quoteIndex');
        if (quoteProvided && indexProvided) {
          failReference('SOURCE_EVIDENCE_REFERENCE_AMBIGUOUS', 'quote_and_quoteIndex_both_present');
        }
        if (!quoteProvided && !indexProvided) {
          failReference('SOURCE_EVIDENCE_REFERENCE_INVALID', 'missing_quote_or_quoteIndex');
        }

        const source = this.sourceFor(conversation, reference.ref, currentTime);
        let quote: string;
        if (indexProvided) {
          const quoteIndex = reference.quoteIndex;
          if (typeof quoteIndex !== 'number' || !Number.isInteger(quoteIndex)) {
            failReference('SOURCE_EVIDENCE_QUOTE_INDEX_INVALID', 'invalid_quoteIndex_type');
          }
          if (quoteIndex < 0) {
            failReference('SOURCE_EVIDENCE_QUOTE_INDEX_INVALID', 'invalid_quoteIndex_range');
          }
          const option = quoteOptionsFor(source.text)[quoteIndex];
          if (!option) {
            failReference('SOURCE_EVIDENCE_QUOTE_INDEX_INVALID', 'invalid_quoteIndex_range');
          }
          quote = option.quote;
        } else {
          if (typeof reference.quote !== 'string') {
            failReference('SOURCE_EVIDENCE_REFERENCE_INVALID', 'invalid_quote_type');
          }
          quote = normalizeQuote(reference.quote);
          if (quote.length < MIN_QUOTE_LENGTH || quote.length > MAX_QUOTE_LENGTH) {
            failReference('SOURCE_EVIDENCE_QUOTE_LENGTH_2_2000', 'quote_length_out_of_range');
          }
          if (!normalizeQuote(source.text).includes(quote)) {
            failReference('SOURCE_EVIDENCE_QUOTE_ABSENT', 'quote_absent');
          }
        }

        return {
          ref: source.ref,
          kind: source.kind,
          locator: cloneLocator(source.locator),
          quote,
        };
      } catch (error) {
        throw indexedReferenceError(error, index);
      }
    });
  }

  private sourceFor(conversation: string, ref: string, currentTime: number): StoredSourceEvidence {
    const owner = this.owners.get(ref);
    if (!owner) throw new Error('SOURCE_EVIDENCE_REF_MISSING');
    if (owner !== conversation) throw new Error('SOURCE_EVIDENCE_CROSS_CONVERSATION');

    const bucket = this.conversations.get(conversation);
    const source = bucket?.entries.get(ref);
    if (!bucket || !source) {
      this.owners.delete(ref);
      throw new Error('SOURCE_EVIDENCE_REF_MISSING');
    }
    if (currentTime >= source.expiresAt) {
      this.remove(conversation, ref, bucket);
      throw new Error('SOURCE_EVIDENCE_EXPIRED');
    }
    return source;
  }

  private pruneExpired(currentTime: number): void {
    for (const [ref, conversation] of this.insertionOrder) {
      const bucket = this.conversations.get(conversation);
      const source = bucket?.entries.get(ref);
      if (bucket && source && currentTime >= source.expiresAt) {
        this.remove(conversation, ref, bucket);
      }
    }
  }

  private remove(conversation: string, ref: string, bucket: ConversationSources): void {
    const source = bucket.entries.get(ref);
    if (!source) return;
    bucket.entries.delete(ref);
    bucket.totalBytes -= source.byteSize;
    this.totalBytes -= source.byteSize;
    this.owners.delete(ref);
    this.insertionOrder.delete(ref);
    if (bucket.entries.size === 0) this.conversations.delete(conversation);
  }
}
