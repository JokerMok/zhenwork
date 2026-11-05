export type DependencyEcosystem = 'python' | 'node';
export type DependencyProbeState = 'READY' | 'MISSING' | 'INCOMPATIBLE' | 'UNVERIFIED';

export type DependencyDeclaration = {
  ecosystem: DependencyEcosystem;
  name: string;
  requested: string;
  source: string;
};

export type CoreDependencyInventory = {
  python?: Record<string, string>;
  node?: Record<string, string>;
};

export type DependencyProbeEvaluation = {
  state: DependencyProbeState;
  declarations: Array<DependencyDeclaration & { installed?: string; state: DependencyProbeState }>;
};
export type DependencyProbeResult = DependencyProbeEvaluation & {
  resourceId: string;
  resourceVersion: number;
  packageSha256: string;
};

export type CoreDependencyProbeRequest = {
  core: { port: number; host?: string; networkMode?: 'container' };
  skills: Array<{ id: string; version: number; packageSha256: string;
    files: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> }>;
};

/**
 * Host-owned transport for an already-running, actor-scoped Core. The Docker
 * implementation must only read package metadata; it must not install, run a
 * Skill script, or give the container network access.
 */
export type CoreDependencyProbe = (request: CoreDependencyProbeRequest) => Promise<CoreDependencyInventory>;

export type DockerCoreDependencyTransport = {
  /** Read installed package metadata from the identified Core container. */
  installedPackages(core: CoreDependencyProbeRequest['core']): Promise<unknown>;
};

/** Adapter boundary used by the mainline Docker owner; Skill bytes never reach the transport. */
export function createDockerCoreDependencyProbe(transport: DockerCoreDependencyTransport): CoreDependencyProbe {
  return async ({ core }) => {
    if (core.networkMode !== 'container') throw new Error('Core dependency probe requires container transport');
    return validateCoreDependencyInventory(await transport.installedPackages(core));
  };
}

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/[-_.]+/g, '-');

export function validateCoreDependencyInventory(value: unknown): CoreDependencyInventory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Core dependency inventory invalid');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !['python', 'node'].includes(key))) {
    throw new Error('Core dependency inventory invalid');
  }
  const result: CoreDependencyInventory = {};
  for (const ecosystem of ['python', 'node'] as const) {
    const packages = source[ecosystem];
    if (packages === undefined) continue;
    if (!packages || typeof packages !== 'object' || Array.isArray(packages) || Object.keys(packages).length > 10_000) {
      throw new Error('Core dependency inventory invalid');
    }
    const checked: Record<string, string> = {};
    for (const [name, version] of Object.entries(packages)) {
      if (!name || name.length > 214 || typeof version !== 'string' || !version || version.length > 100 || /[\r\n\0]/.test(version)) {
        throw new Error('Core dependency inventory invalid');
      }
      checked[name] = version;
    }
    result[ecosystem] = checked;
  }
  return result;
}

function requirements(content: string, source: string): DependencyDeclaration[] | null {
  const result: DependencyDeclaration[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    if (/^(?:-r|--requirement|-e|--editable|--index-url|--extra-index-url|--find-links)\b/i.test(line) ||
        /(?:git\+|https?:|\s@\s)/i.test(line)) return null;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?\s*(.*)$/.exec(line);
    if (!match || !match[1]) return null;
    result.push({ ecosystem: 'python', name: normalizeName(match[1]), requested: match[2].trim() || '*', source });
  }
  return result;
}

function packageJson(content: string, source: string): DependencyDeclaration[] | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const dependencies = parsed.dependencies;
    if (dependencies === undefined) return [];
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return null;
    const result: DependencyDeclaration[] = [];
    for (const [name, requested] of Object.entries(dependencies)) {
      if (!/^@?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || typeof requested !== 'string' || !requested.trim()) return null;
      result.push({ ecosystem: 'node', name: normalizeName(name), requested: requested.trim(), source });
    }
    return result;
  } catch { return null; }
}

export function dependencyDeclarations(files: CoreDependencyProbeRequest['skills'][number]['files']):
  { declarations: DependencyDeclaration[]; unsupported: string[] } {
  const declarations: DependencyDeclaration[] = [];
  const unsupported: string[] = [];
  for (const file of files) {
    const dependencyFile = ['requirements.txt', 'requirements.lock', 'pyproject.toml', 'uv.lock',
      'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(file.path);
    if (file.encoding !== 'utf8') {
      if (dependencyFile) unsupported.push(file.path);
      continue;
    }
    let parsed: DependencyDeclaration[] | null | undefined;
    if (file.path === 'requirements.txt' || file.path === 'requirements.lock') {
      parsed = requirements(file.content, file.path);
    } else if (file.path === 'package.json') {
      parsed = packageJson(file.content, file.path);
    } else if (['pyproject.toml', 'uv.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(file.path)) {
      unsupported.push(file.path);
      continue;
    }
    if (parsed === null) unsupported.push(file.path);
    else if (parsed) declarations.push(...parsed);
  }
  return { declarations, unsupported };
}

function numericVersion(value: string): number[] | null {
  const normalized = value.trim().replace(/^v/, '').split('+', 1)[0];
  if (!/^\d+(?:\.\d+){0,3}$/.test(normalized)) return null;
  return normalized.split('.').map(Number);
}

function compare(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function oneConstraint(installed: number[], raw: string, ecosystem: DependencyEcosystem): boolean | null {
  const match = /^(===|==|=|!=|>=|<=|>|<|~=|\^|~)?\s*v?(\d+(?:\.\d+){0,3})$/.exec(raw.trim());
  if (!match) return null;
  const requested = numericVersion(match[2]);
  if (!requested) return null;
  if (ecosystem === 'node' && requested.length > 3) return null;
  const operator = match[1] || '=';
  if (ecosystem === 'python' && (operator === '^' || operator === '~') ||
      ecosystem === 'node' && operator === '~=' ||
      ecosystem === 'python' && operator === '~=' && requested.length < 2) return null;
  const order = compare(installed, requested);
  if (operator === '=' || operator === '==' || operator === '===') return order === 0;
  if (operator === '!=') return order !== 0;
  if (operator === '>') return order > 0;
  if (operator === '>=') return order >= 0;
  if (operator === '<') return order < 0;
  if (operator === '<=') return order <= 0;
  const upper = [...requested];
  if (operator === '^') {
    const pivot = requested.findIndex((part) => part !== 0);
    const index = pivot < 0 ? 0 : pivot;
    upper[index] += 1; upper.splice(index + 1);
  } else if (operator === '~' || operator === '~=') {
    const index = operator === '~=' && ecosystem === 'python'
      ? (requested.length > 1 ? requested.length - 2 : 0)
      : (requested.length > 1 ? 1 : 0);
    upper[index] += 1; upper.splice(index + 1);
  }
  return order >= 0 && compare(installed, upper) < 0;
}

function satisfies(installed: string, requested: string, ecosystem: DependencyEcosystem): boolean | null {
  if (requested === '*') return true;
  if (requested === 'latest') return null;
  const actual = numericVersion(installed);
  if (!actual || /\|\||\s-\s|\*/.test(requested)) return null;
  if (ecosystem === 'node' && actual.length > 3) return null;
  const parts = requested.split(/\s*,\s*|\s+(?=[<>!=~^])/).filter(Boolean);
  let result = true;
  for (const part of parts) {
    const checked = oneConstraint(actual, part, ecosystem);
    if (checked === null) return null;
    result &&= checked;
  }
  return result;
}

const severity: Record<DependencyProbeState, number> = { READY: 0, UNVERIFIED: 1, INCOMPATIBLE: 2, MISSING: 3 };

/** Pure classification of declared versions against metadata read from the actual Core. */
export function evaluateCoreDependencies(
  files: CoreDependencyProbeRequest['skills'][number]['files'], inventory: CoreDependencyInventory
): DependencyProbeEvaluation {
  const parsed = dependencyDeclarations(files);
  const results: DependencyProbeEvaluation['declarations'] = parsed.declarations.map((item) => {
    const packages = inventory[item.ecosystem];
    if (!packages) return { ...item, state: 'UNVERIFIED' };
    const installed = Object.entries(packages).find(([name]) => normalizeName(name) === item.name)?.[1];
    if (!installed) return { ...item, state: 'MISSING' };
    const compatible = satisfies(installed, item.requested, item.ecosystem);
    return { ...item, installed, state: compatible === null ? 'UNVERIFIED' : compatible ? 'READY' : 'INCOMPATIBLE' };
  });
  if (parsed.unsupported.length) {
    results.push(...parsed.unsupported.map((source) => ({
      ecosystem: source.includes('package') || source.includes('pnpm') || source.includes('yarn') ? 'node' as const : 'python' as const,
      name: '*', requested: '*', source, state: 'UNVERIFIED' as const,
    })));
  }
  const state = results.reduce<DependencyProbeState>((current, item) =>
    severity[item.state] > severity[current] ? item.state : current, 'READY');
  return { state, declarations: results };
}
