/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { PROVIDERS_SWR_KEY, useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { enterpriseControl, enterpriseRequest } from '@/renderer/pages/workspace/workspaceApi';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import useSWR, { useSWRConfig } from 'swr';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ENTERPRISE_PROVIDER_ID = 'rc2-enterprise-model';
const enterpriseModelCode = (id: string) => `rc2-${id}`;

type EnterpriseModel = { id: string; name: string; code?: string; isDefault?: boolean; streaming?: boolean };
type EnterpriseModelBlock = 'loading' | 'failed' | 'pending' | 'empty' | 'invalid' | 'switching' | 'unselected';

export const enterpriseModelBlockKey = {
  loading: 'common.loading',
  failed: 'workspace.modelAvailability.failed',
  pending: 'workspace.modelAvailability.pending',
  empty: 'workspace.errors.noModel',
  invalid: 'workspace.modelAvailability.invalid',
  switching: 'workspace.modelAvailability.switching',
  unselected: 'conversation.chat.noModelSelected',
} as const satisfies Record<EnterpriseModelBlock, string>;

export type AionrsModelSelection = {
  current_model?: TProviderWithModel;
  providers: IProvider[];
  getAvailableModels: (provider: IProvider) => string[];
  handleSelectModel: (provider: IProvider, modelName: string) => Promise<void>;
  getDisplayModelName: (modelName?: string) => string;
  enterpriseCatalog?: {
    models: ReadonlyMap<string, EnterpriseModel>;
    authorizedCount?: number;
    failed: boolean;
    refreshFailed: boolean;
    refreshing: boolean;
    switching: boolean;
    switchFailed: boolean;
    sendBlock: EnterpriseModelBlock | undefined;
    refresh: (syncRuntime: boolean) => Promise<void>;
    isSwitching: () => boolean;
  };
};

export type UseAionrsModelSelectionOptions = {
  initialModel: TProviderWithModel | undefined;
  onSelectModel: (provider: IProvider, modelName: string) => Promise<boolean>;
};

export const useAionrsModelSelection = ({
  initialModel,
  onSelectModel,
}: UseAionrsModelSelectionOptions): AionrsModelSelection => {
  const enterpriseWeb = isEnterpriseWeb();
  const { mutate: mutateCache } = useSWRConfig();
  const {
    data: enterpriseModels,
    error: enterpriseModelsError,
    isValidating,
    mutate,
  } = useSWR(
    enterpriseWeb ? 'organization-models-available' : null,
    async () => {
      const models = await enterpriseControl<EnterpriseModel[]>('/ai/models/available');
      if (!Array.isArray(models)) throw new Error('INVALID_CATALOG_RESPONSE');
      return models.filter((model) => typeof model?.id === 'string' && model.streaming !== false);
    },
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );
  const refreshInFlight = useRef(false);
  const switchInFlight = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);
  const [current_model, setCurrentModel] = useState<TProviderWithModel | undefined>(initialModel);

  useEffect(() => {
    setCurrentModel(initialModel);
  }, [initialModel?.id, initialModel?.use_model]);

  const { providers: allProviders, getAvailableModels: providerModels, formatModelLabel } = useModelProviderList();
  const authorizedModels = useMemo(
    () => new Map(enterpriseModels?.map((model) => [enterpriseModelCode(model.id), model])),
    [enterpriseModels]
  );
  const getAvailableModels = useCallback(
    (provider: IProvider) => providerModels(provider).filter((code) => !enterpriseWeb || authorizedModels.has(code)),
    [providerModels, enterpriseWeb, authorizedModels]
  );

  const providers = useMemo(
    () =>
      allProviders.filter((provider) =>
        enterpriseWeb
          ? provider.id === ENTERPRISE_PROVIDER_ID
          : !provider.platform?.toLowerCase().includes('gemini-with-google-auth')
      ),
    [allProviders, enterpriseWeb]
  );

  const refresh = useCallback(
    async (syncRuntime: boolean) => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      setRefreshing(true);
      setRefreshFailed(false);
      try {
        const [models, runtimeProviders] = await Promise.all([mutate(), mutateCache<IProvider[]>(PROVIDERS_SWR_KEY)]);
        if (!models || !syncRuntime) return;
        const provider = runtimeProviders?.find((item) => item.id === ENTERPRISE_PROVIDER_ID);
        if (models.some((model) => !provider?.models?.includes(enterpriseModelCode(model.id)))) {
          await enterpriseRequest('/enterprise/resources/refresh', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          await mutateCache(PROVIDERS_SWR_KEY);
        }
      } catch {
        setRefreshFailed(true);
      } finally {
        refreshInFlight.current = false;
        setRefreshing(false);
      }
    },
    [mutate, mutateCache]
  );

  const failed = Boolean(enterpriseModelsError);
  const currentCode = current_model?.use_model;
  const currentProvider = providers.find((provider) => provider.id === current_model?.id);
  let sendBlock: EnterpriseModelBlock | undefined;
  if (enterpriseWeb) {
    if (switching) sendBlock = 'switching';
    else if (refreshing || (!enterpriseModels && isValidating)) sendBlock = 'loading';
    else if (enterpriseModelsError) sendBlock = 'failed';
    else if (!enterpriseModels) sendBlock = 'loading';
    else if (enterpriseModels.length === 0) sendBlock = 'empty';
    else if (!currentCode) sendBlock = 'unselected';
    else if (current_model?.id !== ENTERPRISE_PROVIDER_ID || !authorizedModels.has(currentCode)) sendBlock = 'invalid';
    else if (!currentProvider || !getAvailableModels(currentProvider).includes(currentCode)) sendBlock = 'pending';
  }

  const handleSelectModel = useCallback(
    async (provider: IProvider, modelName: string) => {
      const selected = {
        ...(provider as unknown as TProviderWithModel),
        use_model: modelName,
      } as TProviderWithModel;
      if (!enterpriseWeb) {
        if (await onSelectModel(provider, modelName)) setCurrentModel(selected);
        return;
      }
      if (
        switchInFlight.current ||
        refreshInFlight.current ||
        Boolean(enterpriseModelsError) ||
        provider.id !== ENTERPRISE_PROVIDER_ID ||
        !getAvailableModels(provider).includes(modelName) ||
        (current_model?.id === provider.id && currentCode === modelName)
      )
        return;

      switchInFlight.current = true;
      setSwitching(true);
      setSwitchFailed(false);
      try {
        if (await onSelectModel(provider, modelName)) setCurrentModel(selected);
        else setSwitchFailed(true);
      } catch {
        setSwitchFailed(true);
      } finally {
        switchInFlight.current = false;
        setSwitching(false);
      }
    },
    [onSelectModel, enterpriseWeb, enterpriseModelsError, getAvailableModels, current_model?.id, currentCode]
  );

  const getDisplayModelName = useCallback(
    (modelName?: string) => {
      if (!modelName) return '';
      if (enterpriseWeb) {
        const model = authorizedModels.get(modelName);
        return model?.name || model?.code || model?.id || '';
      }
      const label = formatModelLabel(current_model, modelName);
      const maxLength = 20;
      return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
    },
    [current_model, formatModelLabel, enterpriseWeb, authorizedModels]
  );
  const isSwitching = useCallback(() => switchInFlight.current, []);

  return {
    current_model,
    providers,
    getAvailableModels,
    handleSelectModel,
    getDisplayModelName,
    enterpriseCatalog: enterpriseWeb
      ? {
          models: authorizedModels,
          authorizedCount: enterpriseModels?.length,
          failed,
          refreshFailed,
          refreshing: refreshing || isValidating,
          switching,
          switchFailed,
          sendBlock,
          refresh,
          isSwitching,
        }
      : undefined,
  };
};
