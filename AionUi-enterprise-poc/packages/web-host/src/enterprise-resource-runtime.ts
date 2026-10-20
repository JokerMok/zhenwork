import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { EnterpriseMcpProxy } from '../../desktop/src/process/services/enterprise/mcpProxy.mjs';
import { syncEnterpriseResources } from '../../desktop/src/process/services/enterprise/resourceSync.mjs';
import { enterpriseProfilePath } from './enterprise-core.js';
import type { EnterpriseActor, EnterpriseCore } from './enterprise-gateway.js';
import type { Rc2GatewayClient } from './enterprise-rc2-login.mjs';
import { enterpriseProxyBindHost, enterpriseProxyHost } from './enterprise-core-address.js';

type Model = { id: string; code: string; name?: string;
  availableModels?: Array<{ id: string; code: string; name?: string }> };
type CatalogItem = { id: string; name: string; description?: string; source?: string; version: number };
type SkillFile = { path: string; content: string; encoding: 'utf8' | 'base64';
  executable?: boolean; sha256?: string };
type Resource = { version: number; name?: unknown; config?: Record<string, unknown> & { files?: unknown } };
type KnowledgeBinding = { baseId: string; version: number; name: string };
type Assistant = CatalogItem & { instruction: string; modelId: string; modelCode: string;
  skillIds: string[]; mcpIds: string[]; knowledgeBases: KnowledgeBinding[] };
type SkillResource = { id: string; name: string; source: string; version: number;
  files: SkillFile[]; dependencyIds: string[] };
export type RuntimeResourceIssue = { type: 'SKILL' | 'MCP' | 'ASSISTANT'; id: string; code: string };

const MAX_SYNC_SKILL_BYTES = 48 * 1024 * 1024;

export async function enterpriseManagedResourcePath(root: string, actor: EnterpriseActor): Promise<string> {
  const relative = path.relative(path.join(root, 'profiles'), enterpriseProfilePath(root, actor));
  const controlRoot = path.join(root, 'control');
  const canonicalRoot = await realpath(root);
  let dir = root;
  for (const part of ['control', ...relative.split(path.sep)]) {
    dir = path.join(dir, part);
    const current = await lstat(dir).catch((error: NodeJS.ErrnoException): null => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!current) {
      try { await mkdir(dir, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const entry = await lstat(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        (entry.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === 'function' && entry.uid !== process.getuid()) ||
        await realpath(dir) !== path.join(canonicalRoot, path.relative(root, dir))) {
      throw new Error('Enterprise control directory invalid');
    }
  }
  return path.join(controlRoot, relative, 'resources.json');
}

function stringIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new Error('RC2 assistant dependencies invalid');
  }
  return [...new Set(value)];
}

function assistantKnowledgeIds(value: unknown): string[] {
  const ids = stringIds(value);
  if (ids.length > 8) throw new Error('RC2 assistant knowledge limit exceeded');
  return ids;
}

function knowledgeBinding(id: string, resource: Resource): KnowledgeBinding {
  if (!Number.isInteger(resource.version) || typeof resource.name !== 'string' ||
      !resource.name.trim() || resource.name !== resource.name.trim() || resource.name.length > 200 ||
      /[\r\n\0]/.test(resource.name)) {
    throw new Error('RC2 assistant knowledge invalid');
  }
  return { baseId: id, version: resource.version, name: resource.name };
}

function catalog(value: unknown): CatalogItem[] {
  if (!Array.isArray(value)) throw new Error('RC2 assistant catalog invalid');
  return value.filter((item): item is CatalogItem => item && typeof item === 'object' &&
    /^[0-9a-f-]{36}$/i.test(item.id) && typeof item.name === 'string' &&
    Number.isInteger(item.version));
}

function optionalCatalog(value: unknown): CatalogItem[] {
  try { return catalog(value); } catch { return []; }
}

function skillFiles(value: unknown): { files: SkillFile[]; decodedBytes: number } {
  if (value === undefined) return { files: [], decodedBytes: 0 };
  if (!Array.isArray(value) || value.length > 200) throw new Error('RC2 Skill package invalid');
  const paths = new Set<string>();
  let bytes = 0;
  const files = value.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('RC2 Skill package invalid');
    const file = item as Partial<SkillFile>;
    const encoding = file.encoding === undefined ? 'utf8' : file.encoding;
    const parts = typeof file.path === 'string' ? file.path.split('/') : [];
    const rootFiles = new Set(['requirements.txt', 'requirements.lock', 'pyproject.toml', 'uv.lock',
      'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'README.md', 'CHANGELOG.md',
      'USAGE.md', 'VERSION', 'LICENSE', 'LICENSE.md']);
    const directories = new Set(['scripts', 'templates', 'references', 'examples', 'assets', 'docs', 'tests']);
    if (typeof file.path !== 'string' || file.path.length > 400 || file.path.startsWith('/') ||
        file.path.endsWith('/') || file.path.includes('\\') ||
        [...file.path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
        parts.some((part) => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) ||
          part.endsWith('.') || part.endsWith(' ')) ||
        !(parts.length === 1 ? rootFiles.has(file.path) : directories.has(parts[0])) || paths.has(file.path) ||
        typeof file.content !== 'string' || !['utf8', 'base64'].includes(String(encoding)) ||
        (encoding === 'utf8' && file.content.includes('\0')) ||
        (parts.length === 1 && encoding !== 'utf8') ||
        (file.path.startsWith('scripts/') && encoding !== 'utf8') ||
        (file.executable !== undefined && typeof file.executable !== 'boolean') ||
        (file.executable === true && !file.path.startsWith('scripts/')) ||
        (file.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(file.sha256))) {
      throw new Error('RC2 Skill package invalid');
    }
    const decoded = encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
    if (encoding === 'base64' && decoded.toString('base64') !== file.content || decoded.length > 20 * 1024 * 1024 ||
        file.sha256 !== undefined && createHash('sha256').update(decoded).digest('hex') !== file.sha256) {
      throw new Error('RC2 Skill package invalid');
    }
    paths.add(file.path);
    bytes += decoded.length;
    if (bytes > 30 * 1024 * 1024) throw new Error('RC2 Skill package invalid');
    return { path: file.path, content: file.content, encoding,
      ...(file.executable === undefined ? {} : { executable: file.executable }),
      ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }) };
  });
  return { files, decodedBytes: bytes };
}

function declaredDependencyIssue(files: SkillFile[]): 'DEPENDENCY_UNVERIFIED' | null {
  // The Web Host must not inspect its own Python/Node environment: Skills execute in the isolated Core image.
  // Until Core exposes a read-only package diagnostic, keep declarations visible and explicitly unverified.
  return files.some((file) => ['requirements.txt', 'requirements.lock', 'pyproject.toml', 'uv.lock',
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(file.path))
    ? 'DEPENDENCY_UNVERIFIED' : null;
}

function mergedIds(dependencies: string[], catalogItems: CatalogItem[]): string[] {
  return [...new Set([...dependencies, ...catalogItems.map((item) => item.id)])].slice(0, 20);
}

/** Give different RC2 resources with the same Skill name separate Core identities. */
function aliasedSkillSource(source: string, originalName: string, alias: string): string {
  const lines = source.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (lines[0] !== '---' || end < 2) throw new Error('RC2 Skill frontmatter invalid');
  const names = lines.slice(1, end).map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /^name\s*:/.test(line));
  if (names.length !== 1) throw new Error('RC2 Skill frontmatter invalid');
  const match = /^name\s*:\s*(?:"([a-z0-9-]+)"|'([a-z0-9-]+)'|([a-z0-9-]+))\s*$/.exec(names[0].line);
  if ((match?.[1] || match?.[2] || match?.[3]) !== originalName) {
    throw new Error('RC2 Skill manifest name mismatch');
  }
  lines[names[0].index] = `name: ${alias}`;
  return lines.join('\n');
}

/** Mirrors the desktop RC2 adapter into one employee's server-side Core. */
export async function syncEnterpriseWebResources(
  actor: EnterpriseActor,
  core: EnterpriseCore,
  profileRoot: string,
  model: Model | null,
  activeClient: () => Promise<Rc2GatewayClient>,
  relayClient: (conversationId?: string) => Promise<Rc2GatewayClient>
): Promise<{ stop: () => Promise<void>; invalidated: Promise<void>; issues: RuntimeResourceIssue[] }> {
  const profile = enterpriseProfilePath(profileRoot, actor);
  const stage = await mkdtemp(path.join(profile, 'rc2-stage-'));
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const mcpProxies: Array<{ proxy: EnterpriseMcpProxy; port: number }> = [];
  const closeProxies = async () => Promise.allSettled(mcpProxies.map(async ({ proxy, port }) => {
    if (core.unregisterProxyPort) await core.unregisterProxyPort(port).catch(() => {});
    await proxy.stop();
  }));
  try {
    const client = await activeClient();
    const assistants: Assistant[] = [];
    const issues: RuntimeResourceIssue[] = [];
    const catalogs = { skills: [] as CatalogItem[], mcps: [] as CatalogItem[] };
    if (model) {
      const availableModels = model.availableModels?.length ? model.availableModels : [model];
      const [assistantCatalog, skillCatalog, mcpCatalog] = await Promise.allSettled([
        client.resources('ASSISTANT'), client.resources('SKILL'), client.resources('MCP'),
      ]);
      if (skillCatalog.status === 'fulfilled') catalogs.skills = optionalCatalog(skillCatalog.value);
      if (mcpCatalog.status === 'fulfilled') catalogs.mcps = optionalCatalog(mcpCatalog.value);
      for (const item of assistantCatalog.status === 'fulfilled' ? optionalCatalog(assistantCatalog.value).slice(0, 20) : []) {
        try {
          const detail = await client.authorizedResource(item.id, 'ASSISTANT') as Resource;
          const resourceConfig = detail.config || {};
          const selectedModel = availableModels.find((available) => available.id === resourceConfig.modelId);
          if (!selectedModel || typeof resourceConfig.instruction !== 'string' ||
              !resourceConfig.instruction.trim() || resourceConfig.instruction.length > 4000 ||
              detail.version !== item.version) continue;
          let knowledgeIds: string[];
          try { knowledgeIds = assistantKnowledgeIds(resourceConfig.knowledgeIds); }
          catch {
            issues.push({ type: 'ASSISTANT', id: item.id, code: 'INVALID_CONFIGURATION' });
            continue;
          }
          const knowledgeBases: KnowledgeBinding[] = [];
          let knowledgeUnavailable = false;
          for (const knowledgeId of knowledgeIds) {
            try {
              knowledgeBases.push(knowledgeBinding(knowledgeId,
                await client.authorizedResource(knowledgeId, 'KNOWLEDGE') as Resource));
            } catch {
              issues.push({ type: 'ASSISTANT', id: item.id, code: 'KNOWLEDGE_UNAVAILABLE' });
              knowledgeUnavailable = true;
              break;
            }
          }
          if (knowledgeUnavailable) continue;
          assistants.push({ ...item, modelId: selectedModel.id, modelCode: selectedModel.code,
            instruction: resourceConfig.instruction,
            skillIds: stringIds(resourceConfig.skillIds), mcpIds: stringIds(resourceConfig.mcpIds),
            knowledgeBases });
        } catch { /* A malformed or revoked assistant must not prevent employee Core startup. */ }
      }
    }
    const config: Record<string, string> = {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: profile,
      AION_ENTERPRISE_MODEL_CODE: model?.code || '',
      AION_ENTERPRISE_MANAGED_PATH: await enterpriseManagedResourcePath(profileRoot, actor),
    };
    const skillIds = mergedIds(assistants.flatMap((item) => item.skillIds), catalogs.skills);
    const mcpIds = mergedIds(assistants.flatMap((item) => item.mcpIds), catalogs.mcps);
    const bundle: { skills: Array<{ id: string; name: string; path: string; version: number }>;
      mcps: Array<{ resourceId: string; port: string; key: string; host: string;
        version: number; connectionId: string }> } =
      { skills: [], mcps: [] };
    const skillResources: SkillResource[] = [];
    const pendingSkillIds = [...skillIds];
    const visitedSkillIds = new Set<string>();
    let decodedSkillBytes = 0;
    while (pendingSkillIds.length && visitedSkillIds.size < 20) {
      const skillId = pendingSkillIds.shift()!;
      if (visitedSkillIds.has(skillId)) continue;
      visitedSkillIds.add(skillId);
      try {
        const resource = await client.authorizedResource(skillId, 'SKILL') as Resource;
        const manifest = resource.config?.manifest as { name?: unknown; dependencies?: unknown } | undefined;
        const name = manifest?.name;
        const source = resource.config?.source;
        if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
            typeof source !== 'string' || Buffer.byteLength(source) > 24_000 ||
            !Number.isInteger(resource.version)) throw new Error('RC2 Skill invalid');
        const dependencyIds = stringIds(manifest?.dependencies);
        const skillPackage = skillFiles(resource.config?.files);
        const dependencyIssue = declaredDependencyIssue(skillPackage.files);
        if (dependencyIssue) issues.push({ type: 'SKILL', id: skillId, code: dependencyIssue });
        const packageBytes = Buffer.byteLength(source) + skillPackage.decodedBytes;
        if (decodedSkillBytes + packageBytes > MAX_SYNC_SKILL_BYTES) {
          issues.push({ type: 'SKILL', id: skillId, code: 'PACKAGE_BUDGET_EXCEEDED' });
          continue;
        }
        decodedSkillBytes += packageBytes;
        skillResources.push({ id: skillId, name, source, version: resource.version,
          files: skillPackage.files, dependencyIds });
        for (const dependencyId of dependencyIds.toReversed()) {
          if (!visitedSkillIds.has(dependencyId) && !pendingSkillIds.includes(dependencyId)) {
            pendingSkillIds.unshift(dependencyId);
          }
        }
      } catch { issues.push({ type: 'SKILL', id: skillId, code: 'INVALID_OR_UNAVAILABLE' }); }
    }
    let resolvedSkillIds = new Set(skillResources.map((item) => item.id));
    let reduced = true;
    while (reduced) {
      reduced = false;
      for (const item of skillResources) if (resolvedSkillIds.has(item.id) &&
          item.dependencyIds.some((id) => !resolvedSkillIds.has(id))) {
        resolvedSkillIds.delete(item.id);reduced = true;
      }
    }
    for (const item of skillResources) if (!resolvedSkillIds.has(item.id)) {
      issues.push({ type: 'SKILL', id: item.id, code: 'DEPENDENCY_UNAVAILABLE' });
    }
    const resolvedSkillResources = skillResources.filter((item) => resolvedSkillIds.has(item.id));
    const counts = new Map<string, number>();
    for (const item of resolvedSkillResources) counts.set(item.name, (counts.get(item.name) || 0) + 1);
    const names = new Set<string>();
    for (const item of resolvedSkillResources) {
      const name = (counts.get(item.name) || 0) > 1
        ? `${item.name.slice(0, 20).replace(/-+$/, '')}-${item.id.replaceAll('-', '')}` : item.name;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || names.has(name)) {
        throw new Error('RC2 Skill alias invalid');
      }
      names.add(name);
      const source = name === item.name ? item.source : aliasedSkillSource(item.source, item.name, name);
      const skillPath = path.join(stage, name);
      await mkdir(skillPath, { mode: 0o700 });
      await writeFile(path.join(skillPath, 'SKILL.md'), source, { mode: 0o600 });
      for (const file of item.files) {
        const destination = path.join(skillPath, ...file.path.split('/'));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content,
          { mode: file.executable ? 0o700 : 0o600 });
      }
      bundle.skills.push({ id: item.id, name, path: skillPath, version: item.version });
    }
    for (const mcpResourceId of mcpIds) {
      let mcpProxy: EnterpriseMcpProxy | undefined;
      try {
        const resource = await client.authorizedResource(mcpResourceId, 'MCP') as Resource;
        const connection = await client.readyMcpConnection(mcpResourceId);
        await client.authorizedMcpConnection(connection.id, mcpResourceId);
        mcpProxy = new EnterpriseMcpProxy({ connectionId: connection.id, requireConversationId: true,
        client: { relayMcp: async (connectionId, raw, headers, signal, conversationId) => {
          try {
            const current = await relayClient(conversationId);
            const latest = await current.authorizedResource(mcpResourceId, 'MCP') as Resource;
            if (latest.version !== resource.version) return new Response(null, { status: 403 });
            await current.authorizedMcpConnection(connectionId, mcpResourceId);
            return current.relayMcp(connectionId, raw, headers, signal);
          } catch { return new Response(null, { status: 403 }); }
        } },
        });
        const host = enterpriseProxyHost(core);
        const proxy = await mcpProxy.start(enterpriseProxyBindHost(core));
        await core.registerProxyPort?.(proxy.port);
        mcpProxies.push({ proxy: mcpProxy, port: proxy.port });
        bundle.mcps.push({ resourceId: mcpResourceId, port: String(proxy.port), key: proxy.key,
          host, version: resource.version, connectionId: connection.id });
      } catch {
        issues.push({ type: 'MCP', id: mcpResourceId, code: 'CONNECTION_UNAVAILABLE' });
        if (mcpProxy) await mcpProxy.stop().catch(() => {});
      }
    }
    const availableSkills = new Set(bundle.skills.map((item) => item.id));
    const availableMcps = new Set(bundle.mcps.map((item) => item.resourceId));
    const runnable = assistants.filter((item) => {
      const ready = item.skillIds.every((id) => availableSkills.has(id)) &&
        item.mcpIds.every((id) => availableMcps.has(id));
      if (!ready) issues.push({ type: 'ASSISTANT', id: item.id, code: 'DEPENDENCY_UNAVAILABLE' });
      return ready;
    });
    const assistantPath = path.join(stage, 'assistants.json');
    await writeFile(assistantPath, JSON.stringify(runnable), { mode: 0o600 });
    config.AION_ENTERPRISE_ASSISTANTS_PATH = assistantPath;
    Object.assign(bundle, { issues });
    const bundlePath = path.join(stage, 'resources.json');
    await writeFile(bundlePath, JSON.stringify(bundle), { mode: 0o600 });
    config.AION_ENTERPRISE_RESOURCES_PATH = bundlePath;
    const syncResult = await syncEnterpriseResources(core, core.localToken, config);
    let invalidate!: () => void;
    const invalidated = new Promise<void>((resolve) => { invalidate = resolve; });
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const current = await activeClient();
        const availableModelIds = new Set((await current.availableModels()).map((item) => item.id));
        if (model && !availableModelIds.has(model.id)) throw new Error('Model revoked');
        if (runnable.some((item) => !availableModelIds.has(item.modelId))) throw new Error('Assistant model revoked');
        for (const item of runnable) {
          const latest = await current.authorizedResource(item.id, 'ASSISTANT') as Resource;
          if (latest.version !== item.version) throw new Error('Assistant changed');
          for (const knowledge of item.knowledgeBases) {
            const currentKnowledge = await current.authorizedResource(knowledge.baseId, 'KNOWLEDGE') as Resource;
            if (currentKnowledge.version !== knowledge.version) throw new Error('Knowledge changed');
          }
        }
        for (const item of bundle.skills) {
          const latest = await current.authorizedResource(item.id, 'SKILL') as Resource;
          if (latest.version !== item.version) throw new Error('Skill changed');
        }
        for (const item of bundle.mcps) {
          const latest = await current.authorizedResource(item.resourceId, 'MCP') as Resource;
          if (latest.version !== item.version) throw new Error('MCP changed');
          await current.authorizedMcpConnection(item.connectionId, item.resourceId);
        }
      } catch {
        clearInterval(monitor);
        invalidate();
      } finally { checking = false; }
    };
    const monitor = setInterval(() => { void check(); }, 5000);
    monitor.unref();
    return { invalidated, issues: syncResult.issues, stop: async () => {
      clearInterval(monitor);
      await closeProxies();
      await rm(stage, { recursive: true, force: true });
    } };
  } catch (error) {
    await closeProxies();
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
