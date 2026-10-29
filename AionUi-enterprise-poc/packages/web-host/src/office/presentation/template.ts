import { createHash } from 'node:crypto';
import type { DataClient } from '../workbook/analysis/service.js';
import { presentationPython } from './index.js';
import { DEFAULT_THEME, themeSchema, type PresentationTheme } from './types.js';

type PackageFile = { path: string; content: string; encoding?: string; sha256?: string; executable?: boolean };
type TemplateResource = {
  id?: string;
  name?: string;
  version: number;
  config?: { source?: string; files?: PackageFile[] };
};

/** Uses the existing admin Skill upload/version/activation/share workflow, without executing the package. */
export async function presentationTheme(
  client: DataClient,
  selected?: string,
  signal?: AbortSignal
): Promise<PresentationTheme> {
  const resources = (await client.resources('SKILL')) as Array<{ id: string }>;
  if (resources.length > 64) throw new Error('PPT_TEMPLATE_CATALOG_LIMIT_64');
  let candidate: PresentationTheme | undefined;
  for (const entry of selected ? resources.filter((r) => r.id === selected) : resources) {
    const resource = (await client.authorizedResource(entry.id, 'SKILL')) as TemplateResource;
    const files = resource.config?.files || [];
    const config = files.find((f) => f.path === 'references/presentation.json');
    if (!config) {
      if (selected) throw new Error('PPT_TEMPLATE_MANIFEST_REQUIRED');
      continue;
    }
    if (!/^name:\s*zhenwork-presentation-template(?:-[a-z0-9-]+)?\s*$/m.test(resource.config?.source || ''))
      throw new Error('PPT_TEMPLATE_SKILL_NAME_REQUIRED');
    if (config.encoding === 'base64' || config.content.length > 8000) throw new Error('PPT_TEMPLATE_MANIFEST_INVALID');
    let configuration: unknown;
    try {
      configuration = JSON.parse(config.content);
    } catch {
      throw new Error('PPT_TEMPLATE_MANIFEST_INVALID');
    }
    const parsed = themeSchema.safeParse(configuration);
    if (!parsed.success) throw new Error('PPT_TEMPLATE_CONFIGURATION_INVALID');
    if (!selected && !parsed.data.default) continue;
    if (candidate) throw new Error('PPT_MULTIPLE_DEFAULT_TEMPLATES_SELECT_ONE');
    const theme: PresentationTheme = { ...parsed.data, resourceId: entry.id, resourceVersion: resource.version };
    for (const [key, name] of [
      ['templatePath', 'template'],
      ['logoPath', 'logo'],
    ] as const) {
      const target = theme[key];
      if (!target) continue;
      if (!/^templates\/[A-Za-z0-9\u4e00-\u9fff_.-]+\.(?:pptx|png|jpe?g)$/.test(target))
        throw new Error('PPT_TEMPLATE_ASSET_PATH_INVALID');
      const file = files.find((f) => f.path === target);
      if (!file || file.encoding !== 'base64' || file.executable) throw new Error('PPT_TEMPLATE_ASSET_INVALID');
      const bytes = Buffer.from(file.content, 'base64');
      if (
        bytes.length > 1024 * 1024 ||
        (file.sha256 && createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      )
        throw new Error('PPT_TEMPLATE_ASSET_HASH_OR_SIZE_INVALID');
      if (name === 'template') await presentationPython('template', bytes, { signal });
      theme[name] = bytes.toString('base64');
    }
    theme.sha256 = createHash('sha256').update(JSON.stringify(theme)).digest('hex');
    candidate = theme;
  }
  if (selected && !candidate) throw new Error('PPT_TEMPLATE_NOT_AUTHORIZED');
  return (
    candidate || { ...DEFAULT_THEME, sha256: createHash('sha256').update(JSON.stringify(DEFAULT_THEME)).digest('hex') }
  );
}
