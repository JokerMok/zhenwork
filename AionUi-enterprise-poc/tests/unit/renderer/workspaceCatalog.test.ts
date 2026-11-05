import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  availableModelId,
  catalogOrigin,
  preferredAvailableModel,
  workspaceAvailableDependencies,
  workspaceCapabilityPath,
  workspaceCapabilityType,
  workspaceResourcePage,
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

describe('authorized workspace resource pages', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips an explicit capability and defaults an unsupported selection to assistants', () => {
    const target = new URL(workspaceCapabilityPath('MCP'), 'https://workspace.test');
    expect(target.searchParams.get('section')).toBe('abilities');
    expect(workspaceCapabilityType(target.searchParams.get('capability'))).toBe('MCP');
    expect(workspaceCapabilityType('legacy-agent')).toBe('ASSISTANT');
  });

  it('keeps following the server cursor when a filtered page is empty', async () => {
    const item = { id: 'second-page-skill', actions: ['USE'] };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 200, data: { items: [], hasMore: true } }))
      .mockResolvedValueOnce(Response.json({ code: 200, data: { items: [item], hasMore: false } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(workspaceAvailableDependencies('SKILL')).resolves.toEqual([item]);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/enterprise/control/ai/resources?type=SKILL&scope=available&page=1&paged=true',
      '/enterprise/control/ai/resources?type=SKILL&scope=available&page=2&paged=true',
    ]);
  });

  it('treats an invalid catalog response as an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 200, data: null })));
    await expect(workspaceResourcePage('MCP', 'available', 1)).rejects.toMatchObject({
      code: 'INVALID_CATALOG_RESPONSE',
    });
  });
});
