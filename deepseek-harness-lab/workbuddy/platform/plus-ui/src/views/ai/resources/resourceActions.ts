type ResourceState = {
  version: number;
  publishedVersion?: number | null;
  visibility: string;
  enabled: boolean;
  securityDisabled?: boolean;
  reviewState?: string;
  lifecycleState?: string;
};

export function activationReason(row: ResourceState): string {
  if (row.visibility === 'ENTERPRISE_PUBLIC') return '需先撤回发布';
  return row.publishedVersion === row.version ? '当前已激活此版本' : '';
}

export function publicationReason(row: ResourceState): string {
  if (row.reviewState === 'PENDING') return '等待审核结果';
  if (row.securityDisabled) return '资源已被安全停用';
  if (!row.enabled) return '请先启用资源';
  if (row.lifecycleState === 'DRAFT') return '请先激活资源';
  return row.visibility === 'ENTERPRISE_PUBLIC' && row.publishedVersion === row.version ? '此版本已发布' : '';
}
