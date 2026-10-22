type Catalog = { id: string; name?: string; version: number };
type Client = { resources(type: string): Promise<unknown>; authorizedResource(id: string, type: string): Promise<unknown> };
type Loaded = { id: string; name: string; version: number };
export async function checkEnterpriseSkill(client: Client, query: string, loaded: Loaded[], installedNames: string[]): Promise<Record<string, unknown>> {
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
    const detail = await client.authorizedResource(entry.id, 'SKILL') as { version: number };
    const local = loaded.find(item => item.id === entry.id);
    const ready = !!local && local.version === detail.version && installedNames.includes(local.name);
    return { ...base, id: entry.id, name: entry.name, version: detail.version, authorized: true, runtimeName: local?.name, available: ready, reason: ready ? 'READY' : 'RUNTIME_REFRESH_REQUIRED' };
  } catch { return { ...base, available: false, reason: 'UNAVAILABLE_OR_REVOKED' }; }
}
