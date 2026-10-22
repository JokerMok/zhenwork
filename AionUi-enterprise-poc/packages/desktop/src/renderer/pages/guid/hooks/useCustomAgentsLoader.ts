/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useEffect } from 'react';
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
  const enterprise = isEnterpriseWeb();
  const catalogKey = enterprise ? 'enterprise.guid.assistant.catalog' : 'assistants.list';
  const {
    data: catalog,
    error: catalogLoadError,
    isValidating,
  } = useSWR<Assistant[] | { assistants: Assistant[]; revision: number }>(catalogKey, async () => {
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
      // Keep freshness with the shared value: a remounted Guid can reuse SWR's
      // deduplicated result without losing a component-local completion flag.
      return enterprise ? { assistants, revision: Date.now() } : assistants;
    } catch (error) {
      console.error('Failed to load assistants:', error);
      if (isEnterpriseWeb()) throw error;
      return [] as Assistant[];
    }
  });
  const assistants = Array.isArray(catalog) ? catalog : (catalog?.assistants ?? []);
  const catalogRevision = !Array.isArray(catalog) ? (catalog?.revision ?? 0) : 0;

  useEffect(() => {
    void swrMutate(catalogKey);
  }, [catalogKey]);

  return {
    assistants,
    catalogLoading: isValidating,
    catalogRevision,
    catalogError: catalogLoadError instanceof Error ? catalogLoadError.message : undefined,
  };
};
