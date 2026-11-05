import { describe, expect, it } from 'vitest';
import { parseSkillManifest, updateSkillBinding } from './skillManifest';

const skill = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const source = `---
name: test-method
description: |
  First line.
  Second line.
version: 1.0.0
dependencies:
  - ${skill}
requiredTools: [${other}]
---
Do work.
---
Keep the rest of the body.
`;

describe('local Skill bindings', () => {
  it('reads both list styles and updates a block list without affecting the other binding or body', () => {
    const before = parseSkillManifest(source);
    expect(before.bindings).toEqual({dependencies:[skill],requiredTools:[other]});
    const after = parseSkillManifest(updateSkillBinding(source,'dependencies',[other,skill]));
    expect(after.bindings).toEqual({dependencies:[other,skill],requiredTools:[other]});
    expect(after.body).toBe(before.body);
    expect(after.document.get('description')).toBe(before.document.get('description'));
  });

  it('rejects declarations that would otherwise be mistaken for no dependencies', () => {
    expect(() => parseSkillManifest(source.replace(skill,'not-an-id'))).toThrow(/资源 ID/);
    expect(() => parseSkillManifest(source.replace('requiredTools:', 'dependencies:'))).toThrow(/重复字段/);
    expect(() => parseSkillManifest(source.replace('dependencies:', 'dependencies: &ids').replace(`[${other}]`,'*ids'))).toThrow(/引用/);
  });
});
