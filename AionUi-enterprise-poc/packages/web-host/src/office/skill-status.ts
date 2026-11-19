import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
type Catalog = { id: string; name?: string; version: number };
type Client = {
  resources(type: string): Promise<unknown>;
  authorizedResource(id: string, type: string): Promise<unknown>;
};
type Loaded = { id: string; name: string; version: number };
type RuntimeRegistry = { profile: string; registry: Array<{ name: string; location?: string }> };

async function installedFile(directory: string, relative: string, content: string): Promise<string | undefined> {
  const file = path.join(directory, relative);
  try {
    const expected = Buffer.from(content, 'utf8');
    const entry = await lstat(file);
    if (!entry.isFile() || entry.size !== expected.length || (await realpath(file)) !== file) return;
    if ((await readFile(file)).equals(expected)) return file;
  } catch {
    return;
  }
}

async function installedPackage(profile: string, location: string, source: string): Promise<string | undefined> {
  if (!path.isAbsolute(location)) return;
  try {
    const directory = await realpath(location);
    const relative = path.relative(await realpath(profile), directory);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    if (await installedFile(directory, 'SKILL.md', source)) return directory;
  } catch {
    return;
  }
}

type PackageFile = { path: string; sha256: string; executable: boolean; runtimeFile?: string; runtimeError?: string };

export async function checkEnterpriseSkill(
  client: Client,
  query: string,
  loaded: Loaded[],
  installedNames: string[],
  options: { includeInstructions?: boolean; file?: string; runtime?: RuntimeRegistry } = {}
): Promise<Record<string, unknown>> {
  if (!query.trim() || query.length > 100) throw new Error('SKILL_QUERY_REQUIRED_MAX_100');
  const wanted = query.trim().toLowerCase();
  const raw = await client.resources('SKILL');
  if (!Array.isArray(raw)) throw new Error('SKILL_AUTHORIZATION_CATALOG_UNAVAILABLE');
  const catalog = raw.filter(
    (item): item is Catalog => !!item && typeof item.id === 'string' && Number.isInteger(item.version)
  );
  const matched = catalog.filter(
    (item) =>
      item.id.toLowerCase() === wanted ||
      item.name?.toLowerCase() === wanted ||
      loaded.some((local) => local.id === item.id && local.name.toLowerCase() === wanted)
  );
  const base = {
    query,
    scope: 'current employee enterprise Skills; Core builtin/personal Skills are not included',
    checkedAt: new Date().toISOString(),
  };
  if (matched.length !== 1)
    return {
      ...base,
      available: false,
      reason: matched.length > 1 ? 'AMBIGUOUS_USE_RESOURCE_ID' : 'UNAVAILABLE_OR_REVOKED',
      matches: matched.map((item) => ({ id: item.id, name: item.name })),
    };
  const entry = matched[0];
  try {
    const detail = (await client.authorizedResource(entry.id, 'SKILL')) as {
      version: number;
      config?: { source?: unknown; files?: unknown };
    };
    const local = loaded.find((item) => item.id === entry.id);
    const ready = !!local && local.version === detail.version && installedNames.includes(local.name);
    const result = {
      ...base,
      id: entry.id,
      name: entry.name,
      version: detail.version,
      authorized: true,
      runtimeName: local?.name,
      available: ready,
      reason: ready ? 'READY' : 'RUNTIME_REFRESH_REQUIRED',
    };
    if (!ready || (!options.includeInstructions && !options.file)) return result;
    // Read the freshly authorized published package, never a revoked profile cache.
    const source = detail.config?.source;
    if (typeof source !== 'string' || Buffer.byteLength(source) > 24_000)
      return { ...result, available: false, reason: 'PACKAGE_INVALID' };
    const files = detail.config?.files;
    if (files !== undefined && (!Array.isArray(files) || files.length > 200))
      return { ...result, available: false, reason: 'PACKAGE_INVALID' };
    const runtime = options.runtime;
    const location = runtime?.registry.find((item) => item.name === local?.name)?.location;
    const install =
      runtime && typeof location === 'string' && Array.isArray(files) && files.some((file) => file?.executable)
        ? await installedPackage(runtime.profile, location, source)
        : undefined;
    const content: Array<{ path: string; content: string; sha256: string }> = [];
    const catalog: PackageFile[] = [];
    let bytes = 0;
    const omittedFiles: string[] = [];
    for (const file of [
      { path: 'SKILL.md', content: source, encoding: 'utf8' },
      ...(Array.isArray(files) ? files : []),
    ]) {
      if (
        !file ||
        typeof file.path !== 'string' ||
        file.path.length > 240 ||
        file.path.includes('\\') ||
        [...file.path].some((character) => character.charCodeAt(0) < 32) ||
        file.path.split('/').some((part: string) => !part || part === '.' || part === '..') ||
        file.path.startsWith('/')
      )
        return { ...result, available: false, reason: 'PACKAGE_INVALID' };
      const sha =
        typeof file.content === 'string' && file.encoding !== 'base64'
          ? createHash('sha256').update(file.content).digest('hex')
          : file.sha256;
      const catalogFile: PackageFile = { path: file.path, sha256: sha, executable: !!file.executable };
      if (location && catalogFile.executable && (!options.file || options.file === file.path)) {
        const onDisk =
          install &&
          typeof file.content === 'string' &&
          file.encoding !== 'base64' &&
          (!file.sha256 || file.sha256 === sha)
            ? await installedFile(install, file.path, file.content)
            : undefined;
        if (onDisk) catalogFile.runtimeFile = onDisk;
        else {
          const reason = 'RUNTIME_FILE_MISSING_OR_CHANGED';
          if (options.file) return { ...result, available: false, reason, file: file.path };
          catalogFile.runtimeError = reason;
        }
      }
      catalog.push(catalogFile);
      if (
        options.file
          ? file.path !== options.file
          : file.path !== 'SKILL.md' && !/^(references|templates)\//.test(file.path)
      )
        continue;
      if (
        typeof file.content !== 'string' ||
        file.encoding === 'base64' ||
        Buffer.byteLength(file.content) > (options.file ? 128_000 : 32_000) ||
        bytes + Buffer.byteLength(file.content) > (options.file ? 128_000 : 64_000)
      ) {
        if (options.file)
          return { ...result, available: false, reason: 'PACKAGE_TEXT_INVALID_OR_TOO_LARGE', file: file.path };
        omittedFiles.push(file.path);
        continue;
      }
      if (file.sha256 && file.sha256 !== sha)
        return { ...result, available: false, reason: 'PACKAGE_INVALID', file: file.path };
      bytes += Buffer.byteLength(file.content);
      content.push({ path: file.path, content: file.content, sha256: sha });
    }
    if (options.file && !content.length) return { ...result, available: false, reason: 'PACKAGE_FILE_NOT_FOUND' };
    return {
      ...result,
      instructions: content,
      files: catalog,
      omittedFiles,
      note: 'Published package text only; scripts remain subject to normal execution authorization.',
    };
  } catch {
    return { ...base, available: false, reason: 'UNAVAILABLE_OR_REVOKED' };
  }
}
