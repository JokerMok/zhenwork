import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';

const keys = ['dependencies', 'requiredTools'] as const;
export type SkillBinding = (typeof keys)[number];
const allowedFields = new Set(['name', 'description', 'version', 'license', ...keys]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSkillManifest(source: string) {
  const text = source.replace(/\r\n/g, '\n');
  const end = text.indexOf('\n---\n', 4);
  if (!text.startsWith('---\n') || end < 0 || end > 6000 || text.length > 24000 || text.includes('\0')) {
    throw new Error('SKILL.md 必须包含合法的 YAML 声明和正文。');
  }
  const document = parseDocument(text.slice(4, end), { version: '1.1', uniqueKeys: true });
  if (document.errors.length || !isMap(document.contents)) {
    throw new Error('SKILL.md 的 YAML 声明格式无效，请检查缩进和重复字段。');
  }
  for (const { key, value } of document.contents.items) {
    if (!isScalar(key) || typeof key.value !== 'string' || !allowedFields.has(key.value) || isAlias(value)) {
      throw new Error('SKILL.md 包含不支持的声明字段或引用。');
    }
  }
  const bindings = {} as Record<SkillBinding, string[]>;
  for (const key of keys) {
    const node = document.get(key, true);
    if (node == null || (isScalar(node) && node.value === null)) {
      bindings[key] = [];
      continue;
    }
    if (!isSeq(node) || node.items.length > 8) throw new Error(key + ' 必须是最多 8 个资源 ID 的列表。');
    const ids = node.items.map(item => {
      if (!isScalar(item) || typeof item.value !== 'string' || !uuid.test(item.value)) {
        throw new Error(key + ' 包含无法识别的资源 ID。');
      }
      return item.value.toLowerCase();
    });
    if (new Set(ids).size !== ids.length) throw new Error(key + ' 包含重复的资源 ID。');
    bindings[key] = ids;
  }
  return { bindings, document, body: text.slice(end + 5) };
}

export function updateSkillBinding(source: string, key: SkillBinding, ids: string[]) {
  const { document, body } = parseSkillManifest(source);
  document.set(key, ids);
  const updated = '---\n' + document.toString({ directives: false }) + '---\n' + body;
  parseSkillManifest(updated);
  return source.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
}
