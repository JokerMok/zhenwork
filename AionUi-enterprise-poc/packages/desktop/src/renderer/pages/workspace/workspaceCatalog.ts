import type { WorkspaceResource } from './workspaceTypes';

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
