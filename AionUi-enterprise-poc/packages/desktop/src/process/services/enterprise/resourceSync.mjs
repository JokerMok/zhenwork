const MCP_NAME = 'rc2-enterprise-catalog';
const MCP_DESCRIPTION = 'RC2 authorized enterprise MCP';
import fs from 'node:fs/promises';
import path from 'node:path';

const resourceIdPattern = /^[0-9a-f-]{36}$/i;
const RESERVED_UNMANAGED_MCP_NAMES = new Set(['zhenwork-office-tools', 'rc2-enterprise-zhenwork-office-tools']);
const MAX_KNOWLEDGE_RULE_CONTEXT_BYTES = 4096;

function knowledgeRuleContext(value) {
  if (value === undefined) return '';
  if (!Array.isArray(value) || value.length > 8) throw new Error('Enterprise assistant knowledge invalid');
  const seen = new Set();
  const lines = value.map((item) => {
    if (!item || typeof item !== 'object' || !resourceIdPattern.test(item.baseId || '') ||
        seen.has(item.baseId) || !Number.isInteger(item.version) || item.version < 1 ||
        typeof item.name !== 'string' || !item.name.trim() || item.name !== item.name.trim() ||
        item.name.length > 200 || /[\r\n\0]/.test(item.name)) {
      throw new Error('Enterprise assistant knowledge invalid');
    }
    seen.add(item.baseId);
    return `- name=${JSON.stringify(item.name)} | baseId=${item.baseId} | version=${item.version}`;
  });
  if (!lines.length) return '';
  const context = `\n\n默认知识库（仅授权元数据，不是知识正文）：\n${lines.join('\n')}\n` +
    `查询默认知识时，必须使用 search_knowledge 并传入对应 baseId；` +
    `回答必须引用检索返回的原文、文档版本和位置，不得把知识库名称或本清单当作知识正文。`;
  if (Buffer.byteLength(context, 'utf8') > MAX_KNOWLEDGE_RULE_CONTEXT_BYTES) {
    throw new Error('Enterprise assistant knowledge context too large');
  }
  return context;
}

async function validateSkillDirectory(directory, realProfile) {
  const root = await fs.realpath(directory);
  if (!root.startsWith(`${realProfile}${path.sep}`)) throw new Error('Enterprise Skill symlink forbidden');
  let files = 0;
  let bytes = 0;
  const visit = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error('Enterprise Skill symlink forbidden');
      const real = await fs.realpath(candidate);
      if (!real.startsWith(`${root}${path.sep}`)) throw new Error('Enterprise Skill symlink forbidden');
      if (stat.isDirectory()) await visit(candidate);
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > 201 || stat.size > 20 * 1024 * 1024 || bytes > 30 * 1024 * 1024 + 24_000) {
          throw new Error('Enterprise Skill package invalid');
        }
      } else throw new Error('Enterprise Skill package invalid');
    }
  };
  await visit(directory);
  if (!files) throw new Error('Enterprise Skill package invalid');
  return bytes;
}

function coreBase(target) {
  if (typeof target === 'number') return `http://127.0.0.1:${target}`;
  const host = target?.host || '127.0.0.1';
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) {
    throw new Error('Enterprise Core address invalid');
  }
  const parts = host.split('.').map(Number);
  if (!Number.isInteger(target?.port) || target.port < 1 || target.port > 65535 ||
      parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
      !((parts[0] === 127 && parts[1] === 0 && parts[2] === 0 && parts[3] === 1) ||
        parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168))) throw new Error('Enterprise Core address invalid');
  return `http://${host}:${target.port}`;
}

function proxyHost(value) {
  const host = value || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'model-gateway') throw new Error('Enterprise proxy address invalid');
  return host;
}

async function resourceBundle(config) {
  if (!config.AION_ENTERPRISE_RESOURCES_PATH) {
    return {
      skills: config.AION_ENTERPRISE_SKILL_PATH ? [{ id: config.AION_ENTERPRISE_SKILL_ID,
        name: config.AION_ENTERPRISE_SKILL_NAME, path: config.AION_ENTERPRISE_SKILL_PATH }] : [],
      mcps: config.AION_ENTERPRISE_MCP_PROXY_PORT ? [{ resourceId: config.AION_ENTERPRISE_MCP_RESOURCE_ID,
        port: config.AION_ENTERPRISE_MCP_PROXY_PORT, key: config.AION_ENTERPRISE_MCP_PROXY_KEY,
        host: config.AION_ENTERPRISE_MCP_PROXY_HOST,
        name: MCP_NAME }] : [],
      issues: [],
    };
  }
  if (config.AION_ENTERPRISE_ROLE !== 'worker' || !config.AION_ENTERPRISE_PROFILE_DIR) {
    throw new Error('Enterprise resource bundle requires employee profile');
  }
  const file = path.resolve(config.AION_ENTERPRISE_RESOURCES_PATH);
  const profile = path.resolve(config.AION_ENTERPRISE_PROFILE_DIR);
  if (!file.startsWith(`${profile}${path.sep}`)) throw new Error('Enterprise resource bundle path invalid');
  const realProfile = await fs.realpath(profile);
  if (!(await fs.realpath(file)).startsWith(`${realProfile}${path.sep}`)) {
    throw new Error('Enterprise resource bundle symlink forbidden');
  }
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(parsed.skills) || !Array.isArray(parsed.mcps) || !Array.isArray(parsed.issues || []) ||
      parsed.skills.length > 20 || parsed.mcps.length > 20) throw new Error('Enterprise resource bundle invalid');
  parsed.issues ||= [];
  if (parsed.issues.length > 100 || parsed.issues.some((issue) =>
    !['SKILL', 'MCP', 'ASSISTANT'].includes(issue?.type) || typeof issue.id !== 'string' || issue.id.length > 100 ||
    typeof issue.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,80}$/.test(issue.code))) {
    throw new Error('Enterprise resource issue invalid');
  }
  const skillNames = new Set();
  const acceptedSkills = [];
  let decodedSkillBytes = 0;
  for (const item of parsed.skills) {
    if (!resourceIdPattern.test(item?.id || '') ||
        typeof item.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name) ||
        typeof item.path !== 'string' || !path.resolve(item.path).startsWith(`${profile}${path.sep}`) ||
        skillNames.has(item.name)) throw new Error('Enterprise Skill bundle invalid');
    const realSkill = await fs.realpath(item.path);
    const realSource = await fs.realpath(path.join(item.path, 'SKILL.md'));
    if (!realSkill.startsWith(`${realProfile}${path.sep}`) ||
        realSource !== path.join(realSkill, 'SKILL.md')) throw new Error('Enterprise Skill symlink forbidden');
    const packageBytes = await validateSkillDirectory(item.path, realProfile);
    if (decodedSkillBytes + packageBytes > 48 * 1024 * 1024) {
      parsed.issues.push({ type: 'SKILL', id: item.id, code: 'PACKAGE_BUDGET_EXCEEDED' });
      continue;
    }
    decodedSkillBytes += packageBytes;
    skillNames.add(item.name);
    acceptedSkills.push(item);
  }
  parsed.skills = acceptedSkills;
  const mcpIds = new Set();
  for (const item of parsed.mcps) {
    item.host = proxyHost(item.host);
    if (!resourceIdPattern.test(item?.resourceId || '') || !/^\d+$/.test(String(item.port || '')) ||
        Number(item.port) < 1 || Number(item.port) > 65535 ||
        typeof item.key !== 'string' || item.key.length < 20 ||
        mcpIds.has(item.resourceId)) throw new Error('Enterprise MCP bundle invalid');
    mcpIds.add(item.resourceId);
    item.name = `rc2-enterprise-${item.resourceId}`;
  }
  return parsed;
}

function isManagedMcp(item) {
  if (!(item.name === MCP_NAME || /^rc2-enterprise-[0-9a-f-]{36}$/i.test(item.name || '')) ||
      item.description !== MCP_DESCRIPTION || item.transport?.type !== 'http') return false;
  try {
    const url = new URL(item.transport.url);
    return url.protocol === 'http:' && ['127.0.0.1', 'model-gateway'].includes(url.hostname) &&
      url.pathname === '/mcp';
  } catch { return false; }
}

function assistantDefaultsMatch(actual, expected) {
  const sameValues = (left, right) => Array.isArray(right) &&
    (right.length === 0 ? left == null || (Array.isArray(left) && left.length === 0) :
      Array.isArray(left) && left.length === right.length &&
      left.every((value, index) => value === right[index]));
  return actual?.model?.mode === expected.model.mode && actual.model.value === expected.model.value &&
    actual?.skills?.mode === expected.skills.mode && sameValues(actual.skills.value, expected.skills.value) &&
    actual?.mcps?.mode === expected.mcps.mode && sameValues(actual.mcps.value, expected.mcps.value);
}

// Register RC2-authorized resources in AionCore's existing Skill/MCP stores.
// They remain selectable through AionUi's native conversation controls.
export async function syncEnterpriseResources(corePort, localToken, config = process.env, fetchImpl = fetch, hooks = {}) {
  const base = coreBase(corePort);
  const headers = { 'x-aion-enterprise-local-token': localToken, 'Content-Type': 'application/json' };
  const request = async (url, body) => {
    const response = await fetchImpl(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) throw new Error(`AionCore resource sync failed: ${url}`);
    return data.data;
  };
  const bundle = await resourceBundle(config);
  const result = { issues: [...bundle.issues] };
  const currentSkills = new Map();
  const currentMcps = new Map();
  let managedPath = null;
  let old = { skills: [], mcpIds: [], assistantIds: [] };
  let listedMcp = [];
  const newlyImportedSkills = [];
  const newlyRegisteredMcps = [];
  const retainedSkillNames = new Set();
  const retainedMcpIds = new Set();
  const retainedAssistantIds = new Set();
  if (config.AION_ENTERPRISE_ROLE === 'worker') {
    if (!config.AION_ENTERPRISE_PROFILE_DIR) throw new Error('Enterprise profile missing');
    managedPath = config.AION_ENTERPRISE_MANAGED_PATH ||
      path.join(config.AION_ENTERPRISE_PROFILE_DIR, 'enterprise-managed-resources.json');
    if (config.AION_ENTERPRISE_MANAGED_PATH) {
      if (!path.isAbsolute(managedPath) ||
          path.resolve(managedPath).startsWith(`${path.resolve(config.AION_ENTERPRISE_PROFILE_DIR)}${path.sep}`)) {
        throw new Error('Host-managed resource manifest path invalid');
      }
      if ((await fs.lstat(managedPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)))?.isSymbolicLink()) {
        throw new Error('Host-managed resource manifest symlink forbidden');
      }
    }
    old = JSON.parse(await fs.readFile(managedPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '{"skills":[]}';
      throw error;
    }));
    if (!Array.isArray(old.skills) || (old.mcpIds !== undefined && !Array.isArray(old.mcpIds)) ||
        (old.assistantIds !== undefined && !Array.isArray(old.assistantIds))) {
      throw new Error('Enterprise resource manifest invalid');
    }
    if (old.skills.some((name) => typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)))
      throw new Error('Enterprise resource manifest invalid');
    if (old.mcpIds?.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 100))
      throw new Error('Enterprise resource manifest invalid');
    if (old.assistantIds?.some((id) => typeof id !== 'string' || !/^rc2-[0-9a-f-]{36}$/i.test(id)))
      throw new Error('Enterprise resource manifest invalid');
    const mcpResponse = await fetchImpl(`${base}/api/mcp/servers`, { headers });
    const mcpBody = await mcpResponse.json().catch(() => null);
    if (!mcpResponse.ok || mcpBody?.success !== true || !Array.isArray(mcpBody.data)) {
      throw new Error('AionCore MCP list failed');
    }
    listedMcp = mcpBody.data;
  }
  for (const mcp of bundle.mcps) if (listedMcp.some((item) => item.name === mcp.name && !isManagedMcp(item))) {
    throw new Error('Personal MCP name conflicts with reserved enterprise MCP');
  }
  try {
  if (bundle.skills.length) {
    const listed = await fetchImpl(`${base}/api/skills`, { headers });
    const listBody = await listed.json().catch(() => null);
    if (!listed.ok || listBody?.success !== true || !Array.isArray(listBody.data)) {
      throw new Error('AionCore Skill list failed');
    }
    for (const skill of bundle.skills) {
      if (listBody.data.some((item) => item.name === skill.name && !old.skills.includes(skill.name))) {
        result.issues.push({ type: 'SKILL', id: String(skill.id || ''), code: 'NAME_CONFLICT' });
        continue;
      }
      try {
        const imported = await request('/api/skills/import', { skill_path: skill.path });
        if (imported?.skill_name !== skill.name && !imported?.skill_names?.includes(skill.name)) {
          throw new Error('AionCore enterprise Skill import did not match RC2 manifest');
        }
        if (!listBody.data.some((item) => item.name === skill.name)) newlyImportedSkills.push(skill.name);
        currentSkills.set(skill.id, skill.name);
      } catch {
        result.issues.push({ type: 'SKILL', id: String(skill.id || ''), code: 'IMPORT_FAILED' });
      }
    }
    result.skillName = currentSkills.values().next().value;
  }
  for (const mcp of bundle.mcps) {
    try {
      const server = await request('/api/mcp/servers', { name: mcp.name,
        description: MCP_DESCRIPTION,
        transport: { type: 'http', url: `http://${proxyHost(mcp.host)}:${mcp.port}/mcp`,
          headers: { Authorization: `Bearer ${mcp.key}` } } });
      if (server?.name !== mcp.name || !server?.id) throw new Error('AionCore MCP registration failed');
      if (!listedMcp.some((item) => item.name === mcp.name)) newlyRegisteredMcps.push(server.id);
      if (!server.enabled) await request(`/api/mcp/servers/${server.id}/toggle`, {});
      currentMcps.set(mcp.resourceId, server.id);
    } catch {
      result.issues.push({ type: 'MCP', id: mcp.resourceId, code: 'REGISTRATION_FAILED' });
    }
  }
  if (currentMcps.size) {
    const first = bundle.mcps.find((item) => currentMcps.has(item.resourceId));
    result.mcpName = first?.name;
    result.mcpId = first && currentMcps.get(first.resourceId);
  }
  if (config.AION_ENTERPRISE_ROLE === 'worker') {
    const listed = await fetchImpl(`${base}/api/assistants`, { headers });
    const listBody = await listed.json().catch(() => null);
    if (!listed.ok || listBody?.success !== true || !Array.isArray(listBody.data)) {
      throw new Error('AionCore assistant list failed');
    }
    const agentId = listBody.data.find((item) => item.agent?.type === 'aionrs')?.agent_id;
    const assistants = config.AION_ENTERPRISE_ASSISTANTS_PATH
      ? JSON.parse(await fs.readFile(config.AION_ENTERPRISE_ASSISTANTS_PATH, 'utf8')) : [];
    if (!Array.isArray(assistants) || (assistants.length && !agentId)) {
      throw new Error('Enterprise assistant configuration invalid');
    }
    const oldAssistantIds = new Set(old.assistantIds || listBody.data.filter((item) =>
      typeof item.id === 'string' && /^rc2-[0-9a-f-]{36}$/i.test(item.id) &&
      typeof item.description === 'string' &&
      /^(企业提供|企业共享) · RC2 版本 \d+ · 当前账号 USE 权限$/.test(item.description))
      .map((item) => item.id));
    const currentAssistantIds = new Set();
    for (const item of assistants.slice(0, 20)) {
      if (!/^[0-9a-f-]{36}$/i.test(item.id) || !Number.isInteger(item.version) ||
          typeof item.instruction !== 'string' || item.instruction.length > 4000 ||
          (item.modelCode !== undefined &&
            (typeof item.modelCode !== 'string' || !item.modelCode.trim() || item.modelCode.length > 200))) {
        result.issues.push({ type: 'ASSISTANT', id: String(item?.id || ''), code: 'INVALID_CONFIGURATION' });
        continue;
      }
      let knowledgeContext;
      try { knowledgeContext = knowledgeRuleContext(item.knowledgeBases); }
      catch {
        result.issues.push({ type: 'ASSISTANT', id: item.id, code: 'INVALID_CONFIGURATION' });
        continue;
      }
      const skillIds = Array.isArray(item.skillIds) ? item.skillIds : [];
      const mcpIds = Array.isArray(item.mcpIds) ? item.mcpIds : [];
      if (skillIds.some((resourceId) => !currentSkills.has(resourceId)) ||
          mcpIds.some((resourceId) => !currentMcps.has(resourceId))) {
        result.issues.push({ type: 'ASSISTANT', id: item.id, code: 'DEPENDENCY_UNAVAILABLE' });
        continue;
      }
      const skills = skillIds.map((resourceId) => currentSkills.get(resourceId));
      const mcps = mcpIds.map((resourceId) => currentMcps.get(resourceId));
      const id = `rc2-${item.id}`;
      currentAssistantIds.add(id);
      const label = item.source === 'enterprise' ? '企业提供' : '企业共享';
      const payload = { id, agent_id: agentId,
        name: `[${label} v${item.version}] ${item.name}`,
        description: `${label} · RC2 版本 ${item.version} · 当前账号 USE 权限`,
        custom_skill_names: skills,
        defaults: { model: { mode: 'fixed', value: item.modelCode || config.AION_ENTERPRISE_MODEL_CODE },
          skills: { mode: 'fixed', value: skills }, mcps: { mode: 'fixed', value: mcps } },
      };
      try {
        const existed = oldAssistantIds.has(id);
        const created = existed
          ? await (async () => {
          const response = await fetchImpl(`${base}/api/assistants/${encodeURIComponent(id)}`,
            { method: 'PUT', headers, body: JSON.stringify(payload) });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.success !== true) throw new Error('AionCore assistant update failed');
          return body.data;
        })()
          : await request('/api/assistants', payload);
        if (created?.id !== id) throw new Error('AionCore assistant registration failed');
        // Some deployed Core builds accept defaults on PUT but silently leave a newly-created
        // assistant's POST defaults as `auto`. Re-apply only the governance defaults after POST;
        // this is idempotent on current Core and avoids a first-login window with the wrong model,
        // Skill or MCP selection.
        if (!existed) {
          const response = await fetchImpl(`${base}/api/assistants/${encodeURIComponent(id)}`, {
            method: 'PUT', headers, body: JSON.stringify({ defaults: payload.defaults }),
          });
          const body = await response.json().catch(() => null);
          if (!response.ok || body?.success !== true) throw new Error('AionCore assistant defaults update failed');
        }
        const verified = await fetchImpl(`${base}/api/assistants/${encodeURIComponent(id)}`, { headers });
        const verifiedBody = await verified.json().catch(() => null);
        if (!verified.ok || verifiedBody?.success !== true ||
            !assistantDefaultsMatch(verifiedBody.data?.defaults, payload.defaults)) {
          throw new Error('AionCore assistant defaults verification failed');
        }
        await request('/api/skills/assistant-rule/write', {
          assistant_id: id, content: item.instruction + knowledgeContext + (typeof hooks.taskInstruction === 'string' && hooks.taskInstruction.length <= 2000 ? hooks.taskInstruction : ''),
        });
      } catch {
        currentAssistantIds.delete(id);
        result.issues.push({ type: 'ASSISTANT', id: item.id, code: 'REGISTRATION_FAILED' });
      }
    }
    for (const id of oldAssistantIds) if (!currentAssistantIds.has(id)) {
      const deleted = await fetchImpl(`${base}/api/assistants/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
        .catch(() => null);
      if (!deleted?.ok) {
        retainedAssistantIds.add(id);
        result.issues.push({ type: 'ASSISTANT', id, code: 'REVOCATION_FAILED' });
      }
    }
    if (assistants.length > 20) result.issues.push({ type: 'ASSISTANT', id: '', code: 'LIMIT_EXCEEDED' });
    result.assistantCount = currentAssistantIds.size;
    result.assistantIds = [...currentAssistantIds];
  }
  const currentSkillNames = new Set(currentSkills.values());
  const currentMcpIds = new Set(currentMcps.values());
  for (const name of old.skills) if (!currentSkillNames.has(name)) {
    const deleted = await fetchImpl(`${base}/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE', headers })
      .catch(() => null);
    if (!deleted || !deleted.ok && deleted.status !== 404) {
      retainedSkillNames.add(name);
      result.issues.push({ type: 'SKILL', id: name, code: 'REVOCATION_FAILED' });
      if (hooks.removeRevokedSkill) throw new Error('Enterprise Skill revocation failed');
    } else if (hooks.removeRevokedSkill) {
      // Host-only managed package cleanup; personal deletion keeps Core's
      // normal soft-delete behavior. Do not forget this name on failure.
      await hooks.removeRevokedSkill(name);
    }
  }
  for (const item of listedMcp.filter((item) => !RESERVED_UNMANAGED_MCP_NAMES.has(item.name) && isManagedMcp(item) &&
    (old.mcpIds ? old.mcpIds.includes(item.id) : true))) {
    if (currentMcpIds.has(item.id)) continue;
    const deleted = await fetchImpl(`${base}/api/mcp/servers/${encodeURIComponent(item.id)}`, { method: 'DELETE', headers })
      .catch(() => null);
    if (!deleted?.ok) {
      retainedMcpIds.add(item.id);
      result.issues.push({ type: 'MCP', id: item.id, code: 'REVOCATION_FAILED' });
    }
  }
  if (managedPath) {
    const temporary = `${managedPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ skills: [...currentSkillNames, ...retainedSkillNames],
      ...(hooks.removeRevokedSkill ? { skillResources: [...currentSkills].map(([id, name]) => ({ id, name, version: bundle.skills.find(item => item.id === id)?.version })) } : {}),
      mcpIds: [...currentMcpIds, ...retainedMcpIds],
      assistantIds: [...(result.assistantIds || []), ...retainedAssistantIds] }), { mode: 0o600 });
    await fs.rename(temporary, managedPath);
  }
  return result;
  } catch (error) {
    await Promise.allSettled([
      ...newlyImportedSkills.map((name) => fetchImpl(`${base}/api/skills/${encodeURIComponent(name)}`,
        { method: 'DELETE', headers })),
      ...newlyRegisteredMcps.map((id) => fetchImpl(`${base}/api/mcp/servers/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers })),
    ]);
    throw error;
  }
}
