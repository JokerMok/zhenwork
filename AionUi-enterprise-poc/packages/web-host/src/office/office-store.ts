import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EnterpriseActor } from '../enterprise-gateway.js';
import { enterpriseManagedResourcePath } from '../enterprise-resource-runtime.js';

const MAX_FILE = 50 * 1024 * 1024;
const HISTORY_BUDGET = 256 * 1024 * 1024;
type Version = { id: string; createdAt: string; byteSize: number; sha256: string };
type Memory = { id: string; scope: 'personal' | 'project'; projectId?: string; content: string; updatedAt: string };
type State = { files: Record<string, Version[]>; memories: Memory[] };
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string): boolean => file === root || file.startsWith(root + path.sep);

/** Host-owned version and preference storage, outside the employee Core's writable mount. */
export class OfficeStore {
  private static readonly stores = new Map<string, OfficeStore>();
  private static readonly initializing = new Map<string, Promise<OfficeStore>>();
  private sequence: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string) {}

  static async create(profileRoot: string, actor: EnterpriseActor): Promise<OfficeStore> {
    const directory = path.join(path.dirname(await enterpriseManagedResourcePath(profileRoot, actor)), 'office');
    const existing = OfficeStore.stores.get(directory);
    if (existing) return existing;
    const inFlight = OfficeStore.initializing.get(directory);
    if (inFlight) return inFlight;
    const pending = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const store = new OfficeStore(directory);OfficeStore.stores.set(directory, store);return store;
    })();
    OfficeStore.initializing.set(directory, pending);
    try { return await pending; } finally { OfficeStore.initializing.delete(directory); }
  }

  private async state(): Promise<State> {
    try { return JSON.parse(await readFile(path.join(this.directory, 'index.json'), 'utf8')) as State; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: {}, memories: [] }; throw error; }
  }

  private transaction<T>(operation: (state: State) => Promise<T>, commit?: () => Promise<void>): Promise<T> {
    const pending = this.sequence.then(async () => {
      const state = await this.state();
      const original = JSON.stringify(state);
      const result = await operation(state);
      const temporary = path.join(this.directory, `index-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path.join(this.directory, 'index.json'));
      try { await commit?.(); }
      catch (error) {
        await writeFile(temporary, original, { mode: 0o600 });await rename(temporary, path.join(this.directory, 'index.json'));throw error;
      }
      return result;
    });
    this.sequence = pending.catch(() => {});
    return pending;
  }

  async memories(): Promise<Memory[]> { return (await this.state()).memories; }

  async remember(value: Partial<Memory>): Promise<Memory> {
    if (!['personal', 'project'].includes(value.scope || '') || typeof value.content !== 'string' ||
        !value.content.trim() || value.content.length > 8000 ||
        (value.scope === 'project' && (!value.projectId || value.projectId.length > 100))) throw new Error('INVALID_MEMORY');
    return this.transaction(async (state) => {
      const old = value.id ? state.memories.find((item) => item.id === value.id) : undefined;
      if (value.id && !old) throw new Error('MEMORY_NOT_FOUND');
      if (!old && state.memories.length >= 100) throw new Error('MEMORY_LIMIT_100');
      const entry: Memory = { id: old?.id || randomUUID(), scope: value.scope as Memory['scope'],
        ...(value.scope === 'project' ? { projectId: value.projectId } : {}), content: value.content.trim(), updatedAt: new Date().toISOString() };
      state.memories = [...state.memories.filter((item) => item.id !== entry.id), entry];
      return entry;
    });
  }

  async forget(id: string): Promise<void> {
    await this.transaction(async (state) => { state.memories = state.memories.filter((item) => item.id !== id); });
  }

  private async readWorkspace(root: string, name: string): Promise<Buffer> {
    // Linux descriptor paths are required for the host/container isolation guarantee.
    if (process.platform !== 'linux') throw new Error('OFFICE_FILE_STORAGE_REQUIRES_LINUX');
    const base = await realpath(root);
    // Attachment roots include a Core-writable conversation directory. Do not
    // accept a replaced root symlink even when its target is otherwise readable.
    if (base !== path.resolve(root)) throw new Error('WORKSPACE_DENIED');
    const file = await realpath(path.resolve(base, name));
    if (!name || path.isAbsolute(name) || !inside(base, file)) throw new Error('WORKSPACE_DENIED');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_FILE) throw new Error('FILE_LIMIT_50MB');
      // Check the opened inode, rather than trusting a path that Core can change concurrently.
      const opened = process.platform === 'linux' ? await realpath(`/proc/self/fd/${handle.fd}`) : await realpath(file);
      if (!inside(base, opened)) throw new Error('WORKSPACE_DENIED');
      const bytes = await handle.readFile();
      if (bytes.length > MAX_FILE) throw new Error('FILE_LIMIT_50MB');
      const after = await handle.stat();
      if (after.mtimeMs !== info.mtimeMs || after.size !== info.size) throw new Error('FILE_BUSY_RETRY');
      if (/\.(docx|xlsx|pptx)$/i.test(name) && bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) < Math.max(0, bytes.length - 65557)) throw new Error('OFFICE_FILE_INCOMPLETE_RETRY');
      return bytes;
    } finally { await handle.close(); }
  }

  private async snapshot(state: State, name: string, bytes: Buffer): Promise<void> {
    const hash = digest(bytes), versions = state.files[name] || [];
    if (versions.at(-1)?.sha256 === hash) return;
    const used = Object.values(state.files).flat().reduce((n, item) => n + item.byteSize, 0);
    if (used + bytes.length > HISTORY_BUDGET) throw new Error('VERSION_STORAGE_LIMIT_256MB');
    const id = randomUUID();
    await writeFile(path.join(this.directory, id + '.bin'), bytes, { flag: 'wx', mode: 0o600 });
    state.files[name] = [...versions, { id, createdAt: new Date().toISOString(), byteSize: bytes.length, sha256: hash }];
  }

  async files(root: string): Promise<{ files: Array<Record<string, unknown>>; workspaceRoot: string; warnings: string[] }> {
    const base = await realpath(root), names: string[] = [], warnings: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (names.length >= 500) { warnings.push('FILE_LIST_LIMIT_500'); return; }
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.cache'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) names.push(path.relative(base, file));
      }
    };
    await visit(base);
    return this.transaction(async (state) => {
      const files: Array<Record<string, unknown>> = [];
      for (const name of names) {
        try {
          const bytes = await this.readWorkspace(base, name);
          try { await this.snapshot(state, name, bytes); } catch (error) { warnings.push((error as Error).message); }
          const info = await stat(path.join(base, name));
          files.push({ path: name, name: path.basename(name), byteSize: bytes.length, modifiedAt: info.mtime.toISOString(),
            kind: name.startsWith('资料/') ? 'personal' : 'result', versions: [...(state.files[name] || [])].reverse() });
        } catch (error) { warnings.push(`${name}: ${(error as Error).message}`); }
      }
      return { files, workspaceRoot: base, warnings: [...new Set(warnings)] };
    });
  }

  async download(root: string, name: string, version?: string): Promise<Buffer> {
    if (!version) return this.readWorkspace(root, name);
    const entry = (await this.state()).files[name]?.find((item) => item.id === version);
    if (!entry) throw new Error('VERSION_NOT_FOUND');
    const bytes = await readFile(path.join(this.directory, entry.id + '.bin'));
    if (digest(bytes) !== entry.sha256) throw new Error('VERSION_INTEGRITY_ERROR');
    return bytes;
  }

  async upload(root: string, name: string, bytes: Buffer, overwrite = false): Promise<void> {
    if (process.platform !== 'linux') throw new Error('OFFICE_FILE_STORAGE_REQUIRES_LINUX');
    if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) || bytes.length > MAX_FILE) throw new Error('INVALID_FILE_PATH_OR_SIZE');
    const base = await realpath(root), parent = path.dirname(path.resolve(base, name));
    if (!inside(base, parent)) throw new Error('WORKSPACE_DENIED');
    await mkdir(parent, { recursive: true });
    const resolved = await realpath(parent);
    if (!inside(base, resolved)) throw new Error('WORKSPACE_DENIED');
    const dir = await open(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let temporary = '';
    let expectedHash: string | undefined;
    try {
      const directory = process.platform === 'linux' ? `/proc/self/fd/${dir.fd}` : resolved;
      if (process.platform === 'linux' && !inside(base, await realpath(directory))) throw new Error('WORKSPACE_DENIED');
      const target = path.join(directory, path.basename(name));
      temporary = path.join(directory, `.zhenwork-upload-${randomUUID()}.tmp`);
      await this.transaction(async (state) => {
        const used = Object.values(state.files).flat().reduce((n, item) => n + item.byteSize, 0);
        const prior = state.files[name]?.at(-1)?.sha256;
        let previous: Buffer | undefined;
        let required = prior === digest(bytes) ? 0 : bytes.length;
        if (overwrite) {
          previous = await this.readWorkspace(root, name);
          expectedHash = digest(previous);
          if (prior !== digest(previous)) required += previous.length;
        }
        if (used + required > HISTORY_BUDGET) throw new Error('VERSION_STORAGE_LIMIT_256MB');
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_EXCL, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (previous) await this.snapshot(state, name, previous);
        await this.snapshot(state, name, bytes);
      }, async () => {
        if (overwrite) {
          if (digest(await this.readWorkspace(root, name)) !== expectedHash) throw new Error('FILE_CHANGED_RETRY');
          await rename(temporary, target);
        }
        else { await link(temporary, target);await unlink(temporary); }
        temporary = '';await dir.sync();
      });
    } finally { if (temporary) await unlink(temporary).catch(() => {});await dir.close(); }
  }

  async restore(root: string, name: string, version: string): Promise<void> {
    const bytes = await this.download(root, name, version);
    await this.upload(root, name, bytes, true);
  }

  async diff(root: string, name: string, version: string): Promise<Record<string, unknown>> {
    const [current, previous] = await Promise.all([this.download(root, name), this.download(root, name, version)]);
    if (!/\.(txt|md|csv|json|xml|html|py|js|ts)$/i.test(name)) return { kind: 'binary', currentSha256: digest(current), previousSha256: digest(previous), currentBytes: current.length, previousBytes: previous.length };
    const a = previous.toString('utf8').split('\n'), b = current.toString('utf8').split('\n');
    return { kind: 'text', previous: a.slice(0, 1000).join('\n'), current: b.slice(0, 1000).join('\n'), truncated: a.length > 1000 || b.length > 1000 };
  }
}
