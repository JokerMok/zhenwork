import { isEnterpriseWeb } from '@/renderer/utils/platform';

export type EnterpriseBrand = { productName: string; primaryColor?: string; logoDataUrl?: string };

/** Read the same RC2 brand through the desktop IPC or the authenticated Web Host. */
export async function requestEnterpriseBrand(): Promise<EnterpriseBrand | null> {
  const resources = (
    window as Window & { enterpriseResources?: { request: (action: string, args: unknown) => Promise<unknown> } }
  ).enterpriseResources;
  let value: unknown;
  if (resources) {
    value = await resources.request('brand', null);
  } else if (isEnterpriseWeb()) {
    const response = await fetch('/enterprise/brand', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    value = await response.json();
  } else {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const brand = value as Record<string, unknown>;
  if (typeof brand.productName !== 'string' || !brand.productName.trim()) return null;
  return {
    productName: brand.productName.trim(),
    primaryColor: typeof brand.primaryColor === 'string' ? brand.primaryColor : undefined,
    logoDataUrl: typeof brand.logoDataUrl === 'string' ? brand.logoDataUrl : undefined,
  };
}
