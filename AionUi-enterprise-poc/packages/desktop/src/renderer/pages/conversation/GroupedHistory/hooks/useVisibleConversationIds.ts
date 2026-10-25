import { useMemo } from 'react';
import { useOptionalConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { buildVisibleConversationIds } from '../utils/visibleConversationOrder';
import { useWorkspaceExpansionState } from './useWorkspaceExpansionState';

export const useVisibleConversationIds = (): string[] => {
  const layout = useLayoutContext();
  const siderCollapsed = layout?.siderCollapsed ?? false;
  const history = useOptionalConversationHistoryContext();
  const groupedHistory = history?.groupedHistory;
  const expandedWorkspaces = useWorkspaceExpansionState();

  return useMemo(() => {
    if (!groupedHistory) return [];
    return buildVisibleConversationIds({
      ...groupedHistory,
      expandedWorkspaces,
      siderCollapsed,
    });
  }, [groupedHistory, expandedWorkspaces, siderCollapsed]);
};
