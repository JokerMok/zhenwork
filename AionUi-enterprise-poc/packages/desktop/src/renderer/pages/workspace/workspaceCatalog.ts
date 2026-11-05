import { enterpriseControl, WorkspaceApiError } from './workspaceApi';
import type { ResourceScope, WorkspaceResource } from './workspaceTypes';

const CAPABILITY_TYPES = ['ASSISTANT', 'MODEL', 'SKILL', 'MCP', 'TOOL'] as const;
export type CapabilityType = (typeof CAPABILITY_TYPES)[number];
type ResourceType = Exclude<CapabilityType, 'MODEL'>;

export const WORKSPACE_RESOURCE_PAGE_LIMIT = 1000;

export function workspaceCapabilityType(value: string | null): CapabilityType {
  return CAPABILITY_TYPES.find((type) => type === value) ?? 'ASSISTANT';
}

export function workspaceCapabilityPath(type: CapabilityType): string {
  return `/workspace?section=abilities&capability=${type}`;
}

export async function workspaceResourcePage(type: ResourceType, scope: ResourceScope, page: number) {
  const data = await enterpriseControl<{ items: WorkspaceResource[]; hasMore: boolean }>(
    `/ai/resources?type=${type}&scope=${scope}&page=${page}&paged=true`
  );
  if (!Array.isArray(data?.items) || typeof data.hasMore !== 'boolean') {
    throw new WorkspaceApiError('INVALID_CATALOG_RESPONSE', 'Invalid catalog response');
  }
  return data;
}

export async function workspaceAvailableDependencies(type: 'SKILL' | 'MCP'): Promise<WorkspaceResource[]> {
  const resources = new Map<string, WorkspaceResource>();
  for (let page = 1; page <= WORKSPACE_RESOURCE_PAGE_LIMIT; page += 1) {
    const { items, hasMore } = await workspaceResourcePage(type, 'available', page);
    for (const item of items) resources.set(item.id, item);
    if (!hasMore) return [...resources.values()];
  }
  throw new WorkspaceApiError('RESOURCE_CATALOG_LIMIT', 'Resource catalog exceeds the supported range');
}

export type AvailableModel = {
  id?: string;
  modelId?: string;
  code?: string;
  name?: string;
  source?: 'ORGANIZATION' | 'PERSONAL' | string;
  isDefault?: boolean;
  streaming?: boolean;
};

export const availableModelId = (model: AvailableModel): string | undefined => model.id || model.modelId;

export const preferredAvailableModel = (models: AvailableModel[]): AvailableModel | undefined =>
  models.find((model) => model.isDefault && availableModelId(model)) || models.find((model) => availableModelId(model));

export const catalogOrigin = (
  item: Pick<WorkspaceResource, 'ownerType' | 'source'> | AvailableModel
): 'organization' | 'personal' =>
  String(item.source || '').toUpperCase() === 'ORGANIZATION' || ('ownerType' in item && item.ownerType === 'ENTERPRISE')
    ? 'organization'
    : 'personal';
