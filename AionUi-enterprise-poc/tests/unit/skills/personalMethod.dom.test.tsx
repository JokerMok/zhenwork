import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  copiedSkill,
  editableSkill,
  type SkillResource,
} from '../../../packages/desktop/src/renderer/pages/workspace/capabilities/SkillEditor';
const resource = {
  id: '11111111-1111-4111-a111-111111111111',
  name: 'Standard',
  ownerType: 'ENTERPRISE',
  version: 3,
  publishedVersion: 2,
  actions: ['VIEW', 'USE'],
  config: {
    source: '---\nname: standard\nversion: 1.0.0\n---\nMethod steps',
    files: [
      { path: 'references/preferences.json', content: '{"capacityPercent":"90"}', encoding: 'utf8', executable: false },
      { path: 'scripts/process_records.py', content: 'reviewed bytes', encoding: 'utf8', executable: true },
    ],
  },
} as SkillResource;
describe('private methods preserve source and permissions', () => {
  it('does not enable editing organization or other employee read-only resources', () => {
    expect(editableSkill(resource)).toBe(false);
    expect(editableSkill({ ...resource, ownerType: 'USER' })).toBe(false);
    expect(editableSkill({ ...resource, ownerType: 'USER', actions: ['VIEW', 'USE', 'EDIT'] })).toBe(true);
  });
  it('copies every companion byte with independent runtime identity and pinned lineage', async () => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    const before = JSON.stringify(resource);
    const copy = await copiedSkill(resource, 'My weekly inventory', 'abc123');
    expect(JSON.stringify(resource)).toBe(before);
    expect(copy.config.source).toContain('name: zhenwork-personal-abc123');
    expect(copy.config.files.slice(0, 2)).toEqual(resource.config.files);
    const lineage = JSON.parse(copy.config.files[2].content);
    expect(lineage.sourceResourceId).toBe(resource.id);
    expect(lineage.sourceVersion).toBe(2);
    expect(lineage.sourceConfigSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(lineage.updatePolicy).toBe('explicit-only');
  });
});
