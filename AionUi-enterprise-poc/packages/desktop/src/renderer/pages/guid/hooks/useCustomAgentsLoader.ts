/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useEffect, useState } from 'react';
import useSWR, { mutate as swrMutate } from 'swr';

type UseCustomAgentsLoaderResult = {
  /**
   * Preset assistant catalog returned by the backend — merged builtin + user +
   * extension, already sorted. This is the list the Guid pill bar and the
   * Settings list render.
   */
  assistants: Assistant[];
  catalogError?: string;
  catalogLoading: boolean;
  catalogRevision: number;
};

/**
 * Loads the assistant catalog consumed by Guid. Phase 2 removes `/api/agents`
 * as a user-facing candidate source, so this hook intentionally exposes only
 * the assistant list shared with settings/conversation flows.
 */
export const useCustomAgentsLoader = (): UseCustomAgentsLoaderResult => {
  // Preset assistants share their own cache so settings / guid / conversation
  // all see the same list without duplicate HTTP calls.
  const [catalogRevision, setCatalogRevision] = useState(0);
  const { data: assistantList, error: catalogLoadError, isValidating } = useSWR('assistants.list', async () => {
    try {
      if (isEnterpriseWeb()) {
        const response = await fetch('/enterprise/resources/refresh', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(45000),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'RESOURCE_REFRESH_FAILED');
      }
      const assistants = await ipcBridge.assistants.list.invoke();
      setCatalogRevision(Date.now());
      return assistants;
    } catch (error) {
      console.error('Failed to load assistants:', error);
      if (isEnterpriseWeb()) throw error;
      return [] as Assistant[];
    }
  });
  const assistants = assistantList ?? [];

  useEffect(() => {
    void swrMutate('assistants.list');
  }, []);

  return {
    assistants,
    catalogLoading: isValidating,
    catalogRevision,
    catalogError: catalogLoadError instanceof Error ? catalogLoadError.message : undefined,
  };
};
