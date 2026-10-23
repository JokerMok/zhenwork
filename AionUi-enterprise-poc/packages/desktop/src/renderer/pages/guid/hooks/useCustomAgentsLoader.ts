/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useCallback, useRef } from 'react';
import { enterpriseRequest, workspaceErrorCode } from '@/renderer/pages/workspace/workspaceApi';
import useSWR from 'swr';

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
  resourceState?: { state: 'ready' | 'pending' | 'refreshing'; reason?: string };
  retryCatalog: () => void;
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
  const freshness = useRef<{ signature: string; revision: number } | null>(null);
  const retrying = useRef(false);
  const {
    data: catalog,
    error: catalogLoadError,
    isValidating,
    mutate,
  } = useSWR<
    | Assistant[]
    | {
        assistants: Assistant[];
        revision: number;
        resourceState: { state: 'ready' | 'pending' | 'refreshing'; reason?: string };
      }
  >(
    catalogKey,
    async () => {
      try {
        // Entering Guid is a read, never a request to rewrite execution resources.
        // Core initialization is already actor-scoped and synchronized by Host.
        const resourceState = enterprise
          ? await enterpriseRequest<{ state: 'ready' | 'pending' | 'refreshing'; reason?: string }>(
              '/enterprise/resources/status',
              { signal: AbortSignal.timeout(45000) }
            )
          : { state: 'ready' as const };
        const assistants = await ipcBridge.assistants.list.invoke();
        if (!enterprise) return assistants;
        if (!assistants.some((assistant) => assistant.enabled !== false)) throw new Error('NO_AVAILABLE_CAPABILITY');
        const signature = JSON.stringify(assistants);
        if (freshness.current?.signature !== signature) freshness.current = { signature, revision: Date.now() };
        return { assistants, revision: freshness.current!.revision, resourceState };
      } catch (error) {
        if (enterprise) throw error;
        return [] as Assistant[];
      }
    },
    {
      revalidateOnFocus: false,
      errorRetryCount: 0,
      // Poll only an accepted, pending update. This GET cannot enqueue work.
      refreshInterval: (data) => (data && !Array.isArray(data) && data.resourceState.state !== 'ready' ? 15000 : 0),
    }
  );
  const assistants = Array.isArray(catalog) ? catalog : (catalog?.assistants ?? []);
  const catalogRevision = !Array.isArray(catalog) ? (catalog?.revision ?? 0) : 0;
  const retryCatalog = useCallback(() => {
    if (retrying.current || isValidating) return;
    retrying.current = true;
    void mutate().catch(() => {}).finally(() => {
      retrying.current = false;
    });
  }, [isValidating, mutate]);
  return {
    assistants,
    catalogLoading: !catalog && isValidating,
    catalogRevision,
    catalogError: catalogLoadError ? workspaceErrorCode(catalogLoadError) : undefined,
    resourceState: !Array.isArray(catalog) ? catalog?.resourceState : undefined,
    retryCatalog,
  };
};
