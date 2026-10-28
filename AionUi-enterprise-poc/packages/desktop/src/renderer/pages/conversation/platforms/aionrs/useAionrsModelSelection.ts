import useSWR from 'swr';
import { useTranslation } from 'react-i18next';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { enterpriseControl } from '@/renderer/pages/workspace/workspaceApi';
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type AionrsModelSelection = {
  current_model?: TProviderWithModel;
  providers: IProvider[];
  getAvailableModels: (provider: IProvider) => string[];
  handleSelectModel: (provider: IProvider, modelName: string) => Promise<void>;
  getDisplayModelName: (modelName?: string) => string;
};

export type UseAionrsModelSelectionOptions = {
  initialModel: TProviderWithModel | undefined;
  onSelectModel: (provider: IProvider, modelName: string) => Promise<boolean>;
};

export const useAionrsModelSelection = ({
  initialModel,
  onSelectModel,
}: UseAionrsModelSelectionOptions): AionrsModelSelection => {
  const { t } = useTranslation();
  const { data: enterpriseModels } = useSWR(
    isEnterpriseWeb() ? 'organization-models-available' : null,
    () => enterpriseControl<Array<{ id: string; name: string }>>('/ai/models/available'),
    { revalidateOnFocus: true, shouldRetryOnError: false }
  );
  const [current_model, setCurrentModel] = useState<TProviderWithModel | undefined>(initialModel);

  useEffect(() => {
    setCurrentModel(initialModel);
  }, [initialModel?.id, initialModel?.use_model]);

  const { providers: allProviders, getAvailableModels: providerModels, formatModelLabel } = useModelProviderList();
  const getAvailableModels = useCallback(
    (provider: IProvider) =>
      providerModels(provider).filter(
        (code) =>
          !isEnterpriseWeb() ||
          !code.startsWith('rc2-') ||
          enterpriseModels?.some((model) => code === `rc2-${model.id}`)
      ),
    [providerModels, enterpriseModels]
  );

  // AionCore does not support Google Auth — filter it out
  const providers = useMemo(
    () => allProviders.filter((p) => !p.platform?.toLowerCase().includes('gemini-with-google-auth')),
    [allProviders]
  );

  const handleSelectModel = useCallback(
    async (provider: IProvider, modelName: string) => {
      const selected = {
        ...(provider as unknown as TProviderWithModel),
        use_model: modelName,
      } as TProviderWithModel;
      const ok = await onSelectModel(provider, modelName);
      if (ok) {
        setCurrentModel(selected);
      }
    },
    [onSelectModel]
  );

  const getDisplayModelName = useCallback(
    (modelName?: string) => {
      if (!modelName) return '';
      const label =
        isEnterpriseWeb() && modelName.startsWith('rc2-')
          ? enterpriseModels?.find((model) => modelName === `rc2-${model.id}`)?.name || t('common.defaultModel')
          : formatModelLabel(current_model, modelName);
      const maxLength = 20;
      return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
    },
    [current_model, formatModelLabel, enterpriseModels, t]
  );

  return {
    current_model,
    providers,
    getAvailableModels,
    handleSelectModel,
    getDisplayModelName,
  };
};
