import { createHash } from 'node:crypto';
type Catalog = { id: string; name?: string; version: number };
type Client = { resources(type: string): Promise<unknown>; authorizedResource(id: string, type: string): Promise<unknown> };
type Loaded = { id: string; name: string; version: number };
export async function checkEnterpriseSkill(client: Client, query: string, loaded: Loaded[], installedNames: string[], options: { includeInstructions?: boolean; file?: string } = {}): Promise<Record<string, unknown>> {
  if (!query.trim() || query.length > 100) throw new Error('SKILL_QUERY_REQUIRED_MAX_100');
  const wanted = query.trim().toLowerCase();
  const raw = await client.resources('SKILL');
  if (!Array.isArray(raw)) throw new Error('SKILL_AUTHORIZATION_CATALOG_UNAVAILABLE');
  const catalog = raw.filter((item): item is Catalog => !!item && typeof item.id === 'string' && Number.isInteger(item.version));
  const matched = catalog.filter(item => item.id.toLowerCase() === wanted || item.name?.toLowerCase() === wanted || loaded.some(local => local.id === item.id && local.name.toLowerCase() === wanted));
  const base = { query, scope: 'current employee enterprise Skills; Core builtin/personal Skills are not included', checkedAt: new Date().toISOString() };
  if (matched.length !== 1) return { ...base, available: false, reason: matched.length > 1 ? 'AMBIGUOUS_USE_RESOURCE_ID' : 'UNAVAILABLE_OR_REVOKED', matches: matched.map(item => ({ id: item.id, name: item.name })) };
  const entry = matched[0];
  try {
    const detail = await client.authorizedResource(entry.id, 'SKILL') as { version: number; config?: { source?: unknown; files?: unknown } };
    const local = loaded.find(item => item.id === entry.id);
    const ready = !!local && local.version === detail.version && installedNames.includes(local.name);
    const result = { ...base, id: entry.id, name: entry.name, version: detail.version, authorized: true, runtimeName: local?.name, available: ready, reason: ready ? 'READY' : 'RUNTIME_REFRESH_REQUIRED' };
    if (!ready || (!options.includeInstructions && !options.file)) return result;
    // Read the freshly authorized published package, never a revoked profile cache.
    const source = detail.config?.source;
    if (typeof source !== 'string' || Buffer.byteLength(source) > 24_000) return { ...result, available: false, reason: 'PACKAGE_INVALID' };
    const files = detail.config?.files;
    if (files !== undefined && (!Array.isArray(files) || files.length > 200)) return { ...result, available: false, reason: 'PACKAGE_INVALID' };
    const content: Array<{ path: string; content: string; sha256: string }> = [];
    const catalog: Array<{ path: string; sha256: string; executable: boolean }> = [];
    let bytes = 0;
    for (const file of [{ path: 'SKILL.md', content: source, encoding: 'utf8' }, ...(Array.isArray(files) ? files : [])]) {
      if (!file || typeof file.path !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(file.path) || file.path.split('/').some((part: string) => !part || part === '.' || part === '..') || file.path.startsWith('/')) return { ...result, available: false, reason: 'PACKAGE_INVALID' };
      const sha = typeof file.content === 'string' && file.encoding !== 'base64' ? createHash('sha256').update(file.content).digest('hex') : file.sha256;
      catalog.push({ path: file.path, sha256: sha, executable: !!file.executable });
      if (options.file ? file.path !== options.file : file.path !== 'SKILL.md' && !/^(references|templates)\//.test(file.path)) continue;
      if (typeof file.content !== 'string' || file.encoding === 'base64' || Buffer.byteLength(file.content) > 32_000 || file.sha256 && file.sha256 !== sha) return { ...result, available: false, reason: 'PACKAGE_TEXT_INVALID_OR_TOO_LARGE', file: file.path };
      bytes += Buffer.byteLength(file.content);
      if (bytes > 64_000) return { ...result, available: false, reason: 'PACKAGE_TEXT_LIMIT_USE_FILE' };
      content.push({ path: file.path, content: file.content, sha256: sha });
    }
    if (options.file && !content.length) return { ...result, available: false, reason: 'PACKAGE_FILE_NOT_FOUND' };
    return { ...result, instructions: content, files: catalog, note: 'Published package text only; scripts remain subject to normal execution authorization.' };
  } catch { return { ...base, available: false, reason: 'UNAVAILABLE_OR_REVOKED' }; }
}
