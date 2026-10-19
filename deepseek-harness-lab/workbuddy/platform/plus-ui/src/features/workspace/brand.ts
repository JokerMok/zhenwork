import { reactive } from 'vue';
import type { AxiosPromise } from '@/utils/api-types';
import request, { extractErrorMessage } from '@/utils/request';
import { handleThemeStyle } from '@/utils/theme';

export interface BrandConfig {
  productName: string;
  companyName: string;
  loginTitle: string;
  loginSubtitle: string;
  primaryColor: string;
  logoAssetId: string | null;
  faviconAssetId: string | null;
  supportText: string;
  copyright: string;
  version: number;
}

export type BrandUpdatePayload = Omit<BrandConfig, 'version'> & {
  expectedVersion: number;
};

export type BrandStateStatus = 'idle' | 'loading' | 'empty' | 'error' | 'success';

export interface BrandState {
  status: BrandStateStatus;
  data: BrandConfig | null;
  error: string;
}

/** Brand configuration is shared by login, layout and the admin page. */
export const brandState = reactive<BrandState>({
  status: 'idle',
  data: null,
  error: ''
});

let pendingLoad: Promise<BrandConfig | null> | null = null;

export function getBrand(): AxiosPromise<BrandConfig> {
  return request({
    url: '/ai/brand',
    method: 'get'
  });
}

export function putBrand(data: BrandUpdatePayload): AxiosPromise<BrandConfig> {
  return request({
    url: '/ai/brand',
    method: 'put',
    data
  });
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function toAssetId(value: unknown): string | null {
  return value == null || value === '' ? null : String(value);
}

function normalizeBrand(value: unknown): BrandConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('品牌配置返回结构无效');
  }

  const raw = value as Record<string, unknown>;
  const version = Number(raw.version);
  if (!Number.isFinite(version)) {
    throw new Error('品牌配置版本无效');
  }

  return {
    productName: toStringValue(raw.productName),
    companyName: toStringValue(raw.companyName),
    loginTitle: toStringValue(raw.loginTitle),
    loginSubtitle: toStringValue(raw.loginSubtitle),
    primaryColor: toStringValue(raw.primaryColor),
    logoAssetId: toAssetId(raw.logoAssetId),
    faviconAssetId: toAssetId(raw.faviconAssetId),
    supportText: toStringValue(raw.supportText),
    copyright: toStringValue(raw.copyright),
    version
  };
}

async function readableError(error: unknown, fallback: string): Promise<string> {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  const message = await extractErrorMessage(error);
  if (message) {
    return message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

function isCssColor(value: string): boolean {
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', value);
  }
  return /^#[0-9a-f]{3,8}$/i.test(value);
}

/** Apply the current brand to browser chrome and Element Plus theme variables. */
export function applyBrand(config: BrandConfig | null = brandState.data): void {
  if (!config || typeof document === 'undefined') {
    return;
  }

  document.querySelector('link[data-workspace-icon]')?.remove();
  if(config.faviconAssetId){const icon=document.createElement('link');icon.rel='icon';icon.type='image/png';icon.dataset.workspaceIcon='true';icon.href='/api/ai/brand/assets/'+config.faviconAssetId;document.head.appendChild(icon);}
  const title = config.productName.trim() || config.loginTitle.trim();
  if (title) {
    document.title = title;
  }

  const primaryColor = config.primaryColor.trim();
  if (!primaryColor || !isCssColor(primaryColor)) {
    return;
  }

  document.documentElement.style.setProperty('--el-color-primary', primaryColor);
  if (/^#[0-9a-f]{6}$/i.test(primaryColor)) {
    handleThemeStyle(primaryColor);
  }
}

export interface LoadBrandOptions {
  force?: boolean;
}

/** Load once by default; callers can force a fresh GET after an external change. */
export async function loadBrand(options: LoadBrandOptions = {}): Promise<BrandConfig | null> {
  if (!options.force && brandState.status === 'success' && brandState.data) {
    return brandState.data;
  }

  if (pendingLoad) {
    return pendingLoad;
  }

  brandState.status = 'loading';
  brandState.error = '';
  pendingLoad = (async () => {
    try {
      const response = await getBrand();
      if (response?.data == null) {
        brandState.data = null;
        brandState.status = 'empty';
        return null;
      }

      const nextBrand = normalizeBrand(response.data);
      brandState.data = nextBrand;
      brandState.status = 'success';
      applyBrand(nextBrand);
      return nextBrand;
    } catch (error) {
      brandState.status = 'error';
      brandState.error = await readableError(error, '加载品牌配置失败，请稍后重试');
      return null;
    } finally {
      pendingLoad = null;
    }
  })();

  return pendingLoad;
}

/** Save and immediately publish the server-returned version to all consumers. */
export async function updateBrand(data: BrandUpdatePayload): Promise<BrandConfig> {
  const response = await putBrand(data);
  if (response?.data == null) {
    throw new Error('保存品牌配置后未返回最新配置');
  }

  const nextBrand = normalizeBrand(response.data);
  brandState.data = nextBrand;
  brandState.status = 'success';
  brandState.error = '';
  applyBrand(nextBrand);
  return nextBrand;
}

export function isBrandVersionConflict(error: unknown): boolean {
  const candidate = error as {
    response?: {
      status?: number;
      data?: { code?: number; status?: number };
    };
  };
  return (
    candidate?.response?.status === 409 ||
    candidate?.response?.data?.code === 409 ||
    candidate?.response?.data?.status === 409
  );
}

export { readableError as getBrandErrorMessage };
