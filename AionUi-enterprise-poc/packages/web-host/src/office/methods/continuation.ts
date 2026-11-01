import { createHash } from 'node:crypto';
import type { OfficeStore } from '../office-store.js';
import type { OfficeSheet } from '../generate.js';
import { executeMethod, methodPackage, methodTime, type TaskTime } from './index.js';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export type FileRef = { path: string; versionId: string; sha256: string };
type Reader = (file: string, versionId?: string) => Promise<{ bytes: Buffer; relative: string; versionId?: string }>;
type MethodClient = Parameters<typeof executeMethod>[0]['client'];
export type MethodSnapshot = {
  kind: 'ENTERPRISE_METHOD_CONTINUATION_V1';
  resourceId: string;
  configSha256: string;
  processorSha256: string;
  parameters: TaskTime;
  input: FileRef;
  sources: FileRef[];
  continuation: Record<string, unknown>;
  summary: Record<string, unknown>;
  sheets: OfficeSheet[];
};
const snapshotId = (hash: string) => sha('enterprise-method-result:' + hash);
export function relativeMethodPath(file: string): string {
  if (
    !file ||
    file.length > 500 ||
    file.startsWith('/') ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
  )
    throw Error('METHOD_SOURCE_PATH_INVALID');
  return file;
}
function sourceReferencePath(file: string): string {
  if (
    typeof file !== 'string' ||
    !file ||
    file.length > 500 ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').some((p) => p === '.' || p === '..')
  )
    throw Error('METHOD_SOURCE_PATH_INVALID');
  // Absolute upload paths are authorized by readInput against the current actor's upload root.
  return file;
}
export async function pinMethodTime(
  store: Pick<OfficeStore, 'businessResult' | 'saveBusinessResult'>,
  roundKey: string,
  value: TaskTime
): Promise<TaskTime> {
  const key = sha('enterprise-method-time:' + roundKey);
  const old = (await store.businessResult(key)) as { kind?: string; parameters?: TaskTime } | undefined;
  if (old) {
    if (old.kind !== 'METHOD_TASK_TIME_V1' || JSON.stringify(old.parameters) !== JSON.stringify(value))
      throw Error('METHOD_TASK_TIME_CHANGED_RETRY');
    return old.parameters!;
  }
  await store.saveBusinessResult(key, { kind: 'METHOD_TASK_TIME_V1', parameters: value });
  return value;
}
export async function saveMethodSnapshot(
  store: Pick<OfficeStore, 'saveBusinessResult'>,
  outputSha: string,
  snapshot: MethodSnapshot
): Promise<void> {
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 192 * 1024) throw Error('METHOD_CONTINUATION_STORAGE_LIMIT');
  await store.saveBusinessResult(snapshotId(outputSha), snapshot);
}
export async function prepareRevision(options: {
  store: Pick<OfficeStore, 'businessResult' | 'deliveryReceipt' | 'fileReceipt'>;
  client: MethodClient;
  resourceId: string;
  path: string;
  revision: {
    baseVersionId: string;
    baseSha256: string;
    businessIds: string[];
    evidence: FileRef[];
  };
  read: Reader;
  signal?: AbortSignal;
}) {
  const { revision: r, store, client, read } = options;
  relativeMethodPath(options.path);
  if (
    !r ||
    !/^[a-f0-9]{64}$/.test(r.baseSha256) ||
    !/^[a-f0-9-]{36}$/i.test(r.baseVersionId) ||
    !Array.isArray(r.businessIds) ||
    !r.businessIds.length ||
    r.businessIds.length > 20 ||
    new Set(r.businessIds).size !== r.businessIds.length ||
    r.businessIds.some((id) => typeof id !== 'string' || !id || id.length > 100) ||
    !Array.isArray(r.evidence) ||
    !r.evidence.length ||
    r.evidence.length > 20
  )
    throw Error('METHOD_REVISION_INVALID');
  const base = await read(options.path, r.baseVersionId);
  if (sha(base.bytes) !== r.baseSha256) throw Error('METHOD_BASE_VERSION_MISMATCH');
  const snapshot = (await store.businessResult(snapshotId(r.baseSha256))) as MethodSnapshot | undefined;
  if (
    !snapshot ||
    snapshot.kind !== 'ENTERPRISE_METHOD_CONTINUATION_V1' ||
    snapshot.resourceId !== options.resourceId ||
    !snapshot.continuation
  )
    throw Error('METHOD_BASE_NOT_CONTINUABLE');
  const p = await methodPackage(client, options.resourceId);
  if (p.configSha256 !== snapshot.configSha256 || p.processorSha256 !== snapshot.processorSha256)
    throw Error('METHOD_BASE_CONFIG_CHANGED_EXPLICIT_UPGRADE_REQUIRED');
  const pinned = new Map<string, string>();
  // Every frozen input and contract remains guarded by the employee's current access.
  for (const ref of [snapshot.input, ...snapshot.sources]) {
    sourceReferencePath(ref.path);
    // eslint-disable-next-line no-await-in-loop -- Bounded authorization reads stop immediately on denial.
    const actual = await read(ref.path, ref.versionId);
    if (sha(actual.bytes) !== ref.sha256) throw Error('METHOD_SOURCE_VERSION_MISMATCH');
    pinned.set(ref.path, ref.versionId);
  }
  const evidence: Array<FileRef & { contentBase64: string }> = [];
  let bytes = 0;
  for (const ref of r.evidence) {
    sourceReferencePath(ref.path);
    if (
      !/^[a-f0-9-]{36}$/i.test(ref.versionId) ||
      !/^[a-f0-9]{64}$/.test(ref.sha256) ||
      !/\.(json|xlsx)$/i.test(ref.path)
    )
      throw Error('METHOD_EVIDENCE_VERSION_REQUIRED');
    // eslint-disable-next-line no-await-in-loop -- Bounded authorization reads stop immediately on denial.
    const actual = await read(ref.path, ref.versionId);
    bytes += actual.bytes.length;
    if (bytes > 20 * 1024 * 1024) throw Error('METHOD_SOURCE_CONTENT_LIMIT_20MB');
    if (sha(actual.bytes) !== ref.sha256) throw Error('METHOD_EVIDENCE_VERSION_MISMATCH');
    evidence.push({ ...ref, contentBase64: actual.bytes.toString('base64') });
  }
  const key = sha(
    JSON.stringify({
      base: r.baseSha256,
      ids: r.businessIds.toSorted(),
      evidence: [...new Set(evidence.map((e) => e.sha256))].toSorted(),
      config: snapshot.configSha256,
    })
  );
  const previous = await store.deliveryReceipt(key, options.path);
  const latest = await store.fileReceipt(options.path);
  if (previous && latest?.sha256 === previous)
    return {
      reused: true as const,
      path: options.path,
      bytes: (await read(options.path, latest.versionId)).bytes,
      key,
      snapshot: ((await store.businessResult(snapshotId(latest.sha256))) as MethodSnapshot) || snapshot,
    };
  if (latest && latest.sha256 !== r.baseSha256) {
    const current = (await store.businessResult(snapshotId(latest.sha256))) as MethodSnapshot | undefined;
    if (
      current?.kind === 'ENTERPRISE_METHOD_CONTINUATION_V1' &&
      current.resourceId === options.resourceId &&
      current.input.sha256 === snapshot.input.sha256 &&
      JSON.stringify(current.parameters) === JSON.stringify(snapshot.parameters) &&
      evidence.every((e) => (current.continuation.appliedEvidence as string[] | undefined)?.includes(e.sha256))
    ) {
      return {
        reused: true as const,
        path: options.path,
        bytes: (await read(options.path, latest.versionId)).bytes,
        key,
        snapshot: current,
      };
    }
  }
  const applied = snapshot.continuation.appliedEvidence as string[] | undefined;
  if (evidence.every((e) => applied?.includes(e.sha256)) && latest?.sha256 === r.baseSha256)
    return { reused: true as const, path: options.path, bytes: base.bytes, key, snapshot };
  if (!latest || latest.sha256 !== r.baseSha256 || latest.versionId !== r.baseVersionId)
    throw Error('FILE_CHANGED_RETRY');
  const businessPath = String(snapshot.continuation.businessPath || '');
  relativeMethodPath(businessPath);
  const businessRef = snapshot.sources.find((x) => x.path === businessPath);
  if (!businessRef) throw Error('METHOD_BUSINESS_SOURCE_NOT_PINNED');
  const business = await read(businessPath, businessRef.versionId);
  const result = await executeMethod({
    client,
    resourceId: options.resourceId,
    input: business.bytes,
    name: businessPath,
    methods: ['settlement', 'checklist'],
    parameters: methodTime(p.preferences, snapshot.parameters.periods, snapshot.parameters.cutoff),
    authorizedSourcePaths: [...snapshot.sources.map((f) => f.path), ...evidence.map((f) => f.path)],
    revisionPayload: {
      continuationState: {
        ...snapshot.continuation,
        sheets: snapshot.sheets,
        summary: snapshot.summary,
      },
      businessIds: r.businessIds,
      evidence,
    },
    read: (file) => read(file, pinned.get(file)),
    signal: options.signal,
  });
  return { reused: false as const, path: options.path, result, key, snapshot, evidence };
}
