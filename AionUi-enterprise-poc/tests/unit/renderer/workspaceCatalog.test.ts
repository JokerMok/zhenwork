import { describe, expect, it } from 'vitest';
import {
  availableModelId,
  catalogOrigin,
  preferredAvailableModel,
} from '../../../packages/desktop/src/renderer/pages/workspace/workspaceCatalog';

describe('enterprise workspace effective catalog', () => {
  it('prefers the organization default model when creating a personal assistant', () => {
    const models = [
      { id: 'personal-model', source: 'PERSONAL' },
      { id: 'organization-model', source: 'ORGANIZATION', isDefault: true },
    ];
    expect(availableModelId(preferredAvailableModel(models) || {})).toBe('organization-model');
  });

  it('falls back to the first usable model when no default is marked', () => {
    expect(availableModelId(preferredAvailableModel([{ name: 'invalid' }, { modelId: 'usable' }]) || {})).toBe(
      'usable'
    );
  });

  it('labels model and resource origins consistently', () => {
    expect(catalogOrigin({ source: 'ORGANIZATION' })).toBe('organization');
    expect(catalogOrigin({ source: 'PERSONAL' })).toBe('personal');
    expect(catalogOrigin({ ownerType: 'USER', source: 'ORGANIZATION' })).toBe('organization');
    expect(catalogOrigin({ ownerType: 'ENTERPRISE' })).toBe('organization');
    expect(catalogOrigin({ ownerType: 'USER' })).toBe('personal');
  });
});
