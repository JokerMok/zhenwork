import { lstat, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EnterpriseMcpProxy } from '../../desktop/src/process/services/enterprise/mcpProxy.mjs';
import { syncEnterpriseResources } from '../../desktop/src/process/services/enterprise/resourceSync.mjs';
import { enterpriseProfilePath } from './enterprise-core.js';
import type { EnterpriseActor, EnterpriseCore } from './enterprise-gateway.js';
import type { Rc2GatewayClient } from './enterprise-rc2-login.mjs';
import { enterpriseProxyBindHost, enterpriseProxyHost } from './enterprise-core-address.js';

type Model = { id: string; code: string };
type CatalogItem = { id: string; name: string; description?: string; source?: string; version: number };
type Resource = { version: number; config?: Record<string, unknown> };
type Assistant = CatalogItem & { instruction: string; modelId: string; skillIds: string[]; mcpIds: string[] };

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
    if (!current) await mkdir(dir, { mode: 0o700 });
    const entry = await lstat(dir);
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
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

function catalog(value: unknown): CatalogItem[] {
  if (!Array.isArray(value)) throw new Error('RC2 assistant catalog invalid');
  return value.filter((item): item is CatalogItem => item && typeof item === 'object' &&
    /^[0-9a-f-]{36}$/i.test(item.id) && typeof item.name === 'string' &&
    Number.isInteger(item.version));
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
): Promise<{ stop: () => Promise<void>; invalidated: Promise<void> }> {
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
    for (const item of model ? catalog(await client.resources('ASSISTANT')).slice(0, 20) : []) {
      const detail = await client.authorizedResource(item.id, 'ASSISTANT') as Resource;
      const config = detail.config || {};
      if (!model || config.modelId !== model.id || typeof config.instruction !== 'string' ||
          !config.instruction.trim() || config.instruction.length > 4000 || detail.version !== item.version) continue;
      assistants.push({ ...item, modelId: model.id, instruction: config.instruction,
        skillIds: stringIds(config.skillIds), mcpIds: stringIds(config.mcpIds) });
    }
    const config: Record<string, string> = {
      AION_ENTERPRISE_ROLE: 'worker', AION_ENTERPRISE_PROFILE_DIR: profile,
      AION_ENTERPRISE_MODEL_CODE: model?.code || '',
      AION_ENTERPRISE_MANAGED_PATH: await enterpriseManagedResourcePath(profileRoot, actor),
    };
    const skillIds = [...new Set(assistants.flatMap((item) => item.skillIds))];
    const mcpIds = [...new Set(assistants.flatMap((item) => item.mcpIds))];
    if (skillIds.length > 20 || mcpIds.length > 20) throw new Error('Too many RC2 resource dependencies');
    const bundle: { skills: Array<{ id: string; name: string; path: string; version: number }>;
      mcps: Array<{ resourceId: string; port: string; key: string; host: string;
        version: number; connectionId: string }> } =
      { skills: [], mcps: [] };
    const skillResources: Array<{ id: string; name: string; source: string; version: number }> = [];
    for (const skillId of skillIds) {
      const resource = await client.authorizedResource(skillId, 'SKILL') as Resource;
      const name = (resource.config?.manifest as { name?: unknown } | undefined)?.name;
      const source = resource.config?.source;
      if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
          typeof source !== 'string' || source.length > 24_000 ||
          !Number.isInteger(resource.version)) {
        throw new Error('RC2 Skill invalid');
      }
      skillResources.push({ id: skillId, name, source, version: resource.version });
    }
    const counts = new Map<string, number>();
    for (const item of skillResources) counts.set(item.name, (counts.get(item.name) || 0) + 1);
    const names = new Set<string>();
    for (const item of skillResources) {
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
      bundle.skills.push({ id: item.id, name, path: skillPath, version: item.version });
    }
    for (const mcpResourceId of mcpIds) {
      const resource = await client.authorizedResource(mcpResourceId, 'MCP') as Resource;
      const connection = await client.readyMcpConnection(mcpResourceId);
      await client.authorizedMcpConnection(connection.id, mcpResourceId);
      const mcpProxy = new EnterpriseMcpProxy({ connectionId: connection.id, requireConversationId: true,
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
      mcpProxies.push({ proxy: mcpProxy, port: proxy.port });
      await core.registerProxyPort?.(proxy.port);
      bundle.mcps.push({ resourceId: mcpResourceId, port: String(proxy.port), key: proxy.key,
        host,
        version: resource.version, connectionId: connection.id });
    }
    const runnable = assistants;
    const assistantPath = path.join(stage, 'assistants.json');
    await writeFile(assistantPath, JSON.stringify(runnable), { mode: 0o600 });
    config.AION_ENTERPRISE_ASSISTANTS_PATH = assistantPath;
    const bundlePath = path.join(stage, 'resources.json');
    await writeFile(bundlePath, JSON.stringify(bundle), { mode: 0o600 });
    config.AION_ENTERPRISE_RESOURCES_PATH = bundlePath;
    await syncEnterpriseResources(core, core.localToken, config);
    let invalidate!: () => void;
    const invalidated = new Promise<void>((resolve) => { invalidate = resolve; });
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        const current = await activeClient();
        if (model && !(await current.availableModels()).some((item) => item.id === model.id)) throw new Error('Model revoked');
        for (const item of runnable) {
          const latest = await current.authorizedResource(item.id, 'ASSISTANT') as Resource;
          if (latest.version !== item.version) throw new Error('Assistant changed');
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
    return { invalidated, stop: async () => {
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
