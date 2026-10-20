import { randomUUID } from 'node:crypto';

export type SourceEvidenceKind = 'web' | 'knowledge' | 'workspace';

export type SourceEvidenceInput = {
  kind: SourceEvidenceKind;
  text: string;
  locator: unknown;
};

export type SourceEvidenceReference = {
  ref: string;
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
const MIN_QUOTE_LENGTH = 8;
const MAX_QUOTE_LENGTH = 2000;

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

  verify(conversation: string, references: SourceEvidenceReference[]): VerifiedSourceEvidence[] {
    if (!validConversation(conversation)) throw new Error('SOURCE_EVIDENCE_CONVERSATION_INVALID');
    if (!Array.isArray(references) || references.length < 1 || references.length > MAX_REFERENCES) {
      throw new Error('SOURCE_EVIDENCE_REFS_LIMIT_1_32');
    }

    const currentTime = this.now();
    return references.map((reference) => {
      if (!reference || typeof reference.ref !== 'string' || typeof reference.quote !== 'string') {
        throw new Error('SOURCE_EVIDENCE_REFERENCE_INVALID');
      }
      const owner = this.owners.get(reference.ref);
      if (!owner) throw new Error('SOURCE_EVIDENCE_REF_MISSING');
      if (owner !== conversation) throw new Error('SOURCE_EVIDENCE_CROSS_CONVERSATION');

      const bucket = this.conversations.get(conversation);
      const source = bucket?.entries.get(reference.ref);
      if (!bucket || !source) {
        this.owners.delete(reference.ref);
        throw new Error('SOURCE_EVIDENCE_REF_MISSING');
      }
      if (currentTime >= source.expiresAt) {
        this.remove(conversation, reference.ref, bucket);
        throw new Error('SOURCE_EVIDENCE_EXPIRED');
      }

      const quote = normalizeQuote(reference.quote);
      if (quote.length < MIN_QUOTE_LENGTH || quote.length > MAX_QUOTE_LENGTH) {
        throw new Error('SOURCE_EVIDENCE_QUOTE_LENGTH_8_2000');
      }
      if (!normalizeQuote(source.text).includes(quote)) {
        throw new Error('SOURCE_EVIDENCE_QUOTE_ABSENT');
      }

      return {
        ref: source.ref,
        kind: source.kind,
        locator: cloneLocator(source.locator),
        quote,
      };
    });
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
