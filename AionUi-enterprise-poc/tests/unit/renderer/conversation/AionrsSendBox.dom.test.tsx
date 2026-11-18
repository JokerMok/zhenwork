import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '@arco-design/web-react';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import AionrsSendBox from '@/renderer/pages/conversation/platforms/aionrs/AionrsSendBox';
import type { AionrsModelSelection } from '@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection';
import {
  employeeDraftScope,
  initialMessageKey,
  writeDraft,
  type InitialMessage,
} from '@/renderer/hooks/chat/employeeDraftStorage';
import type { TeamSendBoxRuntime } from '@/renderer/pages/team/components/teamSendRuntime';

const {
  ensureConversationRuntimeMock,
  sendMessageInvokeMock,
  translateMock,
  useTeamPermissionMock,
  setSendBoxHandlerMock,
  markSendFailedMock,
  markSendStartedMock,
  markSendAcceptedMock,
  sendBoxPropsSpy,
  enqueueMock,
  clearFilesMock,
  draftMutateMock,
  draftContentRef,
  draftUploadFilesRef,
  runtimeViewIsProcessingRef,
} = vi.hoisted(() => ({
  ensureConversationRuntimeMock: vi.fn().mockResolvedValue({ recovered: false, config_options: [], runtime: null }),
  sendMessageInvokeMock: vi.fn().mockResolvedValue(undefined),
  translateMock: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  useTeamPermissionMock: vi.fn(),
  setSendBoxHandlerMock: vi.fn(),
  markSendFailedMock: vi.fn(),
  markSendStartedMock: vi.fn(),
  markSendAcceptedMock: vi.fn(),
  sendBoxPropsSpy: vi.fn(),
  enqueueMock: vi.fn(),
  clearFilesMock: vi.fn(),
  draftMutateMock: vi.fn(),
  draftContentRef: { current: '' },
  draftUploadFilesRef: { current: [] as string[] },
  runtimeViewIsProcessingRef: { current: false },
}));

vi.mock('@/renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'test-employee' } }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      sendMessage: {
        invoke: sendMessageInvokeMock,
      },
      stop: {
        invoke: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

vi.mock('@/renderer/components/chat/SendBox', () => ({
  default: ({
    onSend,
    onChange,
    active,
    onFocused,
    disabled,
    sendDisabled,
    rightTools,
    sendButtonPrefix,
    topRightOverlay,
    onAddToDraft,
    addToDraftDisabled,
    selectedSessions,
    onSelectedSessionsChange,
    crossSessionEnabled,
    isTeamConversation,
  }: {
    onSend: (message: string) => Promise<void>;
    onChange?: (value: string) => void;
    active?: boolean;
    onFocused?: () => void;
    disabled?: boolean;
    sendDisabled?: boolean;
    rightTools?: React.ReactNode;
    sendButtonPrefix?: React.ReactNode;
    topRightOverlay?: React.ReactNode;
    onAddToDraft?: () => void;
    addToDraftDisabled?: boolean;
    selectedSessions?: Array<{ id: string }>;
    onSelectedSessionsChange?: (sessions: Array<{ id: string }>) => void;
    crossSessionEnabled?: boolean;
    isTeamConversation?: boolean;
  }) => {
    sendBoxPropsSpy({
      active,
      onFocused,
      disabled,
      sendDisabled,
      onAddToDraft,
      addToDraftDisabled,
      selectedSessions,
      onSelectedSessionsChange,
      crossSessionEnabled,
      isTeamConversation,
    });
    return (
      <div>
        {rightTools}
        {sendButtonPrefix}
        {topRightOverlay}
        <button type='button' onClick={() => onChange?.('hello')}>
          change
        </button>
        <button
          type='button'
          onClick={() => {
            // Models the Enter-key submit path: in the real component Enter
            // reaches `onSend` regardless of the button's visual `sendDisabled`
            // state — the parent decides whether to block+toast.
            void onSend('Hello').catch(() => {});
          }}
        >
          send
        </button>
      </div>
    );
  },
}));

vi.mock('@/renderer/pages/conversation/platforms/aionrs/AionrsModelSelector', () => ({
  default: () => null,
}));
vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/CommandQueuePanel', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/MobileActionSheet', () => ({
  default: () => null,
  useAttachEntry: () => ({ entries: [], hiddenFileInput: null }),
}));
vi.mock('@/renderer/components/chat/ThoughtDisplay', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FileAttachButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/FilePreview', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/HorizontalFileList', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/hooks/agent/useAcpConfigOptions', () => ({
  classifyConfigSetError: () => 'unknown',
  useAcpConfigOptions: () => ({
    setStatus: { state: 'idle' },
    mode: null,
    model: null,
    thoughtLevel: null,
    reload: vi.fn(),
    setConfigOption: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({
    loadedSkills: [],
    loadedMcpStatuses: [],
  }),
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({
  useAutoTitle: () => ({
    checkAndUpdateTitle: vi.fn(),
  }),
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({
  getSendBoxDraftHook: () => () => ({
    data: {
      atPath: [],
      uploadFile: draftUploadFilesRef.current,
      content: draftContentRef.current,
    },
    mutate: draftMutateMock,
  }),
}));
vi.mock('@/renderer/hooks/chat/useSendBoxFiles', () => ({
  useSendBoxFiles: () => ({
    handleFilesAdded: vi.fn(),
    clearFiles: clearFilesMock,
  }),
  createSetUploadFile: () => vi.fn(),
}));
vi.mock('@/renderer/hooks/chat/useSlashCommands', () => ({
  useSlashCommands: () => [],
}));
vi.mock('@/renderer/hooks/file/useOpenFileSelector', () => ({
  useOpenFileSelector: () => ({
    openFileSelector: vi.fn(),
    onSlashBuiltinCommand: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/platforms/useConversationCommandQueue', () => ({
  useConversationCommandQueue: () => ({
    items: [],
    isPaused: false,
    isInteractionLocked: false,
    hasPendingCommands: false,
    enqueue: enqueueMock,
    remove: vi.fn(),
    clear: vi.fn(),
    reorder: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    lockInteraction: vi.fn(),
    unlockInteraction: vi.fn(),
    resetActiveExecution: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    hydrated: true,
    canSendMessage: true,
    get isProcessing() {
      return runtimeViewIsProcessingRef.current;
    },
    state: 'idle',
    view: { pendingConfirmations: 0 },
    markSendStarted: markSendStartedMock,
    markSendAccepted: markSendAcceptedMock,
    markSendFailed: markSendFailedMock,
  }),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn().mockResolvedValue({
    extra: {
      workspace: '/tmp/workspace',
    },
  }),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCreateError', () => ({
  getConversationRuntimeWorkspaceErrorMessage: () => 'workspace failed',
}));
vi.mock('@/renderer/pages/conversation/utils/ensureConversationRuntime', () => ({
  ensureConversationRuntime: ensureConversationRuntimeMock,
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: setSendBoxHandlerMock,
  }),
}));
vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({
  useTeamPermission: useTeamPermissionMock,
}));
vi.mock('@/renderer/services/FileService', () => ({
  allSupportedExts: [],
}));
vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    emit: vi.fn(),
  },
  useAddEventListener: vi.fn(),
}));
vi.mock('@/renderer/utils/file/fileSelection', () => ({
  mergeFileSelectionItems: vi.fn((items: unknown[]) => items),
}));
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  Input: (await importOriginal<typeof import('@arco-design/web-react')>()).Input,
  Message: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
  Tag: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type='button' onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock('@icon-park/react', () => ({
  Brain: () => null,
  MagicHat: () => null,
  Shield: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateMock }),
}));
vi.mock('@/renderer/pages/conversation/platforms/aionrs/useAionrsMessage', () => ({
  useAionrsMessage: () => ({
    thought: { subject: '', description: '' },
    running: false,
    setActiveMsgId: vi.fn(),
    setWaitingResponse: vi.fn(),
    resetState: vi.fn(),
  }),
}));

const modelSelection = {
  current_model: {
    provider_id: 'openai',
    model: 'gpt-4.1',
    use_model: 'openai/gpt-4.1',
  },
} as AionrsModelSelection;

describe('AionrsSendBox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureConversationRuntimeMock.mockResolvedValue({ recovered: false, config_options: [], runtime: null });
    useTeamPermissionMock.mockReturnValue(null);
    draftContentRef.current = '';
    draftUploadFilesRef.current = [];
    runtimeViewIsProcessingRef.current = false;
  });

  it('keeps the composer editable and blocks keyboard submission when the selected model is revoked', async () => {
    render(
      <AionrsSendBox
        conversation_id='conv-1'
        modelSelection={{
          ...modelSelection,
          enterpriseCatalog: {
            models: new Map(),
            authorizedCount: 1,
            failed: false,
            refreshFailed: false,
            refreshing: false,
            switching: false,
            switchFailed: false,
            sendBlock: 'invalid',
            refresh: vi.fn().mockResolvedValue(undefined),
            isSwitching: () => false,
          },
        }}
      />
    );
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    expect(sendBoxPropsSpy).toHaveBeenLastCalledWith(expect.objectContaining({ disabled: false, sendDisabled: true }));
    expect(clearFilesMock).not.toHaveBeenCalled();
    expect(sendMessageInvokeMock).not.toHaveBeenCalled();
  });

  it('does not warm up team session when draft content changes', async () => {
    const warmupSession = vi.fn().mockResolvedValue(undefined);
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession,
    });

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
    await waitFor(() => {
      expect(warmupSession).toHaveBeenCalled();
    });
    warmupSession.mockClear();

    await act(async () => {
      screen.getByRole('button', { name: 'change' }).click();
    });

    expect(warmupSession).not.toHaveBeenCalled();
  });

  it('still warms up team session before sending', async () => {
    const warmupSession = vi.fn().mockResolvedValue(undefined);
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession,
    });

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
    await waitFor(() => {
      expect(warmupSession).toHaveBeenCalled();
    });
    warmupSession.mockClear();

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => {
      expect(warmupSession).toHaveBeenCalledTimes(1);
    });
  });

  it('does not start standalone runtime while preparing a team conversation', async () => {
    const warmupSession = vi.fn().mockResolvedValue(undefined);
    useTeamPermissionMock.mockReturnValue({
      isTeamMode: true,
      isLeaderAgent: true,
      leaderConversationId: 'conv-1',
      allConversationIds: ['conv-1'],
      propagateMode: vi.fn(),
      warmupSession,
    });

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);

    await waitFor(() => {
      expect(warmupSession).toHaveBeenCalled();
    });
    expect(ensureConversationRuntimeMock).not.toHaveBeenCalled();
  });

  it('uses runtime ensure instead of legacy warmup for standalone runtime preparation', async () => {
    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);

    await waitFor(() => {
      expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1');
    });
  });

  it('suppresses visible error and preserves runtime gate for active-turn busy conflicts', async () => {
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: '/api/conversations/conv-1/messages',
        status: 409,
        body: { success: false, code: 'CONFLICT', error: 'conversation conv-1 is already running' },
      })
    );

    render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
    await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

    await act(async () => {
      screen.getByRole('button', { name: 'send' }).click();
    });

    await waitFor(() => {
      expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
    });
    expect(markSendFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'busy_conflict', busyKind: 'active_turn' })
    );
    expect(Message.error).not.toHaveBeenCalled();
  });

  it('passes teamRuntime.isActive and onFocus down to SendBox as active/onFocused', () => {
    const onFocus = vi.fn();
    render(
      <AionrsSendBox
        conversation_id='conv-1'
        modelSelection={modelSelection}
        teamRuntime={{ loading: false, startedAtMs: null, isActive: true, onFocus } as unknown as TeamSendBoxRuntime}
      />
    );
    const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { active?: boolean; onFocused?: () => void };
    expect(props.active).toBe(true);
    props.onFocused?.();
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  describe('mid-turn interjection controls', () => {
    it('disables the send button and blocks Enter with a toast while replying, without implicitly enqueuing', async () => {
      runtimeViewIsProcessingRef.current = true;
      draftContentRef.current = 'hello world';

      render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
      await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { sendDisabled?: boolean };
      expect(props.sendDisabled).toBe(true);

      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });

      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(clearFilesMock).not.toHaveBeenCalled();
      expect(Message.warning).toHaveBeenCalledWith(
        'This agent is still working, so the message can’t be sent directly. Save it to Draft box and send it later.'
      );
    });

    it('sends normally while idle', async () => {
      runtimeViewIsProcessingRef.current = false;

      render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
      await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { sendDisabled?: boolean };
      expect(props.sendDisabled).toBe(false);

      await act(async () => {
        screen.getByRole('button', { name: 'send' }).click();
      });

      await waitFor(() => {
        expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
      });
      expect(enqueueMock).not.toHaveBeenCalled();
      expect(Message.warning).not.toHaveBeenCalled();
    });

    it('shows the add-to-draft-box entry with a non-empty draft while replying, and clicking it enqueues without executing', async () => {
      runtimeViewIsProcessingRef.current = true;
      draftContentRef.current = 'hello world';

      render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
      await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { onAddToDraft?: () => void };
      expect(props.onAddToDraft).toBeDefined();
      await act(async () => {
        props.onAddToDraft?.();
      });

      expect(enqueueMock).toHaveBeenCalledWith({ input: 'hello world', files: [], sessions: undefined });
      expect(sendMessageInvokeMock).not.toHaveBeenCalled();
      expect(clearFilesMock).toHaveBeenCalled();
      const updater = draftMutateMock.mock.calls.at(-1)?.[0] as (prev: { content: string }) => { content: string };
      expect(updater({ content: 'hello world' })).toEqual(expect.objectContaining({ content: '' }));
    });

    it('carries `@@` session references into the draft box and clears them from the send box', async () => {
      // The draft box is where the references are most likely to be lost:
      // enqueue rebuilds the item, and a message that reaches the agent without
      // its session block fails silently on both sides.
      runtimeViewIsProcessingRef.current = true;
      draftContentRef.current = 'hello world';

      render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
      await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

      type SessionProps = {
        onAddToDraft?: () => void;
        onSelectedSessionsChange?: (sessions: Array<{ id: string }>) => void;
        selectedSessions?: Array<{ id: string }>;
      };
      const latestProps = (): SessionProps => sendBoxPropsSpy.mock.calls.at(-1)?.[0] as SessionProps;

      await act(async () => {
        latestProps().onSelectedSessionsChange?.([{ id: 'conv_target' }]);
      });
      // Re-read: picking a session re-renders, so the previous props snapshot
      // holds a stale `onAddToDraft` closure over the empty selection.
      await act(async () => {
        latestProps().onAddToDraft?.();
      });

      expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ sessions: [{ id: 'conv_target' }] }));
      expect(latestProps().selectedSessions).toEqual([]);
    });

    it('shows the add-to-draft-box option while idle, as long as the draft is non-empty', async () => {
      // Visibility is keyed only to the draft, not to the agent's busy state —
      // clicking while idle is semantically fine (the queue's own mode governs).
      runtimeViewIsProcessingRef.current = false;
      draftContentRef.current = 'hello world';

      render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
      await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as { onAddToDraft?: () => void };
      expect(props.onAddToDraft).toBeDefined();
    });

    it('disables the Draft box action with an empty draft, even while replying', async () => {
      runtimeViewIsProcessingRef.current = true;
      draftContentRef.current = '';

      render(<AionrsSendBox conversation_id='conv-1' modelSelection={modelSelection} />);
      await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith('conv-1'));

      const props = sendBoxPropsSpy.mock.calls.at(-1)?.[0] as {
        onAddToDraft?: () => void;
        addToDraftDisabled?: boolean;
      };
      expect(props.onAddToDraft).toBeDefined();
      expect(props.addToDraftDisabled).toBe(true);
    });
  });
});

describe('ordinary submission recovery', () => {
  const id = 'conv-recovery';
  const receipt = { turn_id: 'native-attempt', msg_id: '', runtime: {} };
  const originalPath = '/uploads/reimbursement-v1.xlsx';
  type SessionProps = {
    selectedSessions?: Array<{ id: string }>;
    onSelectedSessionsChange?: (sessions: Array<{ id: string }>) => void;
  };
  const latestProps = (): SessionProps => sendBoxPropsSpy.mock.calls.at(-1)?.[0] as SessionProps;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__AION_ENTERPRISE_WEB__', true);
    vi.stubGlobal('crypto', webcrypto);
    sendMessageInvokeMock.mockReset();
    ensureConversationRuntimeMock.mockResolvedValue({ recovered: false, config_options: [], runtime: null });
    useTeamPermissionMock.mockReturnValue(null);
    draftContentRef.current = 'Hello';
    draftUploadFilesRef.current = [originalPath];
    runtimeViewIsProcessingRef.current = false;
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'TASK_NOT_FOUND' }), { status: 404 }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
    draftUploadFilesRef.current = [];
  });

  async function selectSession(sessionId: string) {
    await act(async () => latestProps().onSelectedSessionsChange?.([{ id: sessionId }]));
  }

  it('keeps attachments and @@ references when the host requires external review before another message', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          id,
          updatedAt: 1,
          attempts: [
            {
              id: 'failed-write',
              state: 'failed',
              requiresExternalReview: true,
              artifacts: [],
              steps: [],
            },
          ],
        })
      )
    );
    sendMessageInvokeMock.mockRejectedValue(
      new BackendHttpError({
        method: 'POST',
        path: `/api/conversations/${id}/messages`,
        status: 409,
        body: { error: 'TASK_EXTERNAL_REVIEW_REQUIRED' },
      })
    );
    render(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
    await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith(id));
    await selectSession('expense-context');
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(markSendFailedMock).toHaveBeenCalled());

    expect(sendMessageInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Hello',
        files: [{ kind: 'upload', path: originalPath }],
        sessions: [{ id: 'expense-context' }],
      })
    );
    expect(clearFilesMock).not.toHaveBeenCalled();
    expect(latestProps().selectedSessions).toEqual([{ id: 'expense-context' }]);
  });

  it('clears the submitted attachments and @@ references only after acceptance', async () => {
    let accept!: (value: typeof receipt) => void;
    sendMessageInvokeMock.mockImplementation(() => new Promise((resolve) => (accept = resolve)));
    render(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
    await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith(id));
    await selectSession('expense-context');
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));

    expect(clearFilesMock).not.toHaveBeenCalled();
    expect(latestProps().selectedSessions).toEqual([{ id: 'expense-context' }]);
    await act(async () => accept(receipt));
    expect(clearFilesMock).toHaveBeenCalledTimes(1);
    expect(latestProps().selectedSessions).toEqual([]);
  });

  it('does not clear newer attachments or @@ references when an earlier send is accepted late', async () => {
    let accept!: (value: typeof receipt) => void;
    sendMessageInvokeMock.mockImplementation(() => new Promise((resolve) => (accept = resolve)));
    const view = render(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
    await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith(id));
    await selectSession('expense-context');
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));

    draftUploadFilesRef.current = ['/uploads/next-report.xlsx'];
    view.rerender(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
    await selectSession('next-context');
    clearFilesMock.mockClear();
    await act(async () => accept(receipt));

    expect(sendMessageInvokeMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        files: [{ kind: 'upload', path: originalPath }],
        sessions: [{ id: 'expense-context' }],
      })
    );
    expect(clearFilesMock).not.toHaveBeenCalled();
    expect(latestProps().selectedSessions).toEqual([{ id: 'next-context' }]);
  });

  it('isolates a late acceptance from the next draft and allows a fresh identical request on return', async () => {
    let accept!: (value: typeof receipt) => void;
    sendMessageInvokeMock.mockImplementation(() => new Promise((resolve) => (accept = resolve)));
    const view = render(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
    await waitFor(() => expect(ensureConversationRuntimeMock).toHaveBeenCalledWith(id));
    await selectSession('expense-context');
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1));

    const previousComposer = screen.getByRole('button', { name: 'send' });
    draftContentRef.current = 'A different task';
    draftUploadFilesRef.current = ['/uploads/next-report.xlsx'];
    view.rerender(<AionrsSendBox conversation_id='conv-next' modelSelection={modelSelection} />);
    // The real entry must remount its shared composer to release the previous
    // request's local loading state, not only fence its eventual callback.
    expect(screen.getByRole('button', { name: 'send' })).not.toBe(previousComposer);
    await selectSession('next-context');
    clearFilesMock.mockClear();
    draftMutateMock.mockClear();
    await act(async () => accept(receipt));

    expect(clearFilesMock).not.toHaveBeenCalled();
    expect(draftMutateMock).not.toHaveBeenCalled();
    expect(latestProps().selectedSessions).toEqual([{ id: 'next-context' }]);

    // Acceptance belongs to the original request even while its composer is
    // away. Returning and sending the same payload must start a new request.
    const acceptedId = sendMessageInvokeMock.mock.calls[0]?.[0].execution_id;
    sendMessageInvokeMock.mockResolvedValueOnce(receipt);
    draftContentRef.current = 'Hello';
    draftUploadFilesRef.current = [originalPath];
    view.rerender(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
    await selectSession('expense-context');
    await act(async () => screen.getByRole('button', { name: 'send' }).click());
    await waitFor(() => expect(sendMessageInvokeMock).toHaveBeenCalledTimes(2));
    expect(sendMessageInvokeMock.mock.calls[1]?.[0].execution_id).not.toBe(acceptedId);
  });
});

describe('initial message recovery', () => {
  const id = 'conv-first';
  const executionId = '5d471dc2-194e-4b07-82d2-565c52325180';
  const input = 'Use the fixed historical version';
  const files = [{ kind: 'upload', path: '/uploads/stock-v1.xlsx' }] as const;
  const receipt = { turn_id: 'native-attempt', msg_id: '', runtime: {} };
  let accepted = false;

  function mount() {
    return render(<AionrsSendBox conversation_id={id} modelSelection={modelSelection} />);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('__AION_ENTERPRISE_WEB__', true);
    accepted = false;
    sendMessageInvokeMock.mockReset();
    draftUploadFilesRef.current = [];
    sessionStorage.clear();
    writeDraft<InitialMessage>(initialMessageKey(employeeDraftScope('test-employee')!, id), {
      executionId,
      input,
      files: [...files],
      phase: 'ready',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              accepted
                ? {
                    id,
                    updatedAt: 1,
                    attempts: [
                      { id: receipt.turn_id, requestId: executionId, state: 'queued', artifacts: [], steps: [] },
                    ],
                  }
                : { error: 'TASK_NOT_FOUND' }
            ),
            { status: accepted ? 200 : 404 }
          )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('leaves the original body and attachment visible after admission fails and the route remounts', async () => {
    sendMessageInvokeMock
      .mockRejectedValueOnce(
        new BackendHttpError({ method: 'POST', path: '/messages', status: 429, body: { error: 'TASK_QUEUE_FULL' } })
      )
      .mockResolvedValueOnce(receipt);
    const initial = mount();
    await screen.findByText('guid.initialMessage.rejected');
    initial.unmount();
    mount();
    expect(await screen.findByText(input)).toBeTruthy();
    expect(screen.getByText('stock-v1.xlsx')).toBeTruthy();
    expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
    await act(async () => screen.getByRole('button', { name: 'common.retry' }).click());
    expect(sendMessageInvokeMock.mock.calls).toEqual([
      [expect.objectContaining({ input, files, execution_id: executionId })],
      [expect.objectContaining({ input, files, execution_id: executionId })],
    ]);
    expect(screen.queryByText(input)).toBeNull();
  });

  it('lets a rejected first message be edited across remounts and sends the same attachment with a new ID', async () => {
    sendMessageInvokeMock
      .mockRejectedValueOnce(
        new BackendHttpError({
          method: 'POST',
          path: '/messages',
          status: 413,
          body: { error: 'TASK_INPUT_TOO_LARGE' },
        })
      )
      .mockResolvedValueOnce(receipt);
    const initial = mount();
    await screen.findByText('guid.initialMessage.rejected');
    fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
    const edited = 'Read the original workbook';
    const editor = screen.getByRole('textbox', { name: 'guid.initialMessage.label' });
    expect(editor).toHaveValue(input);
    fireEvent.change(editor, { target: { value: edited } });
    initial.unmount();

    mount();
    expect(screen.getByRole('textbox', { name: 'guid.initialMessage.label' })).toHaveValue(edited);
    expect(screen.getByText('stock-v1.xlsx')).toBeTruthy();
    expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
    await act(async () => screen.getByRole('button', { name: 'common.send' }).click());
    expect(sendMessageInvokeMock).toHaveBeenLastCalledWith(expect.objectContaining({ input: edited, files }));
    expect(sendMessageInvokeMock.mock.lastCall?.[0].execution_id).not.toBe(executionId);
  });

  it('retries the original request after a temporary status lookup failure', async () => {
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ error: 'TASK_SERVICE_UNAVAILABLE' }), { status: 503 })
    );
    sendMessageInvokeMock.mockRejectedValueOnce(new TypeError('Accepted response lost')).mockResolvedValueOnce(receipt);
    mount();
    await screen.findByText('guid.initialMessage.uncertain');
    await act(async () => screen.getByRole('button', { name: 'guid.initialMessage.check' }).click());
    await screen.findByText('guid.initialMessage.uncertain');
    expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull();
    await act(async () => screen.getByRole('button', { name: 'common.retry' }).click());
    expect(sendMessageInvokeMock.mock.calls).toEqual([
      [expect.objectContaining({ input, files, execution_id: executionId })],
      [expect.objectContaining({ input, files, execution_id: executionId })],
    ]);
  });

  it('keeps an unknown request through a missing task snapshot and reconciles its persisted request ID', async () => {
    sendMessageInvokeMock.mockRejectedValueOnce(new TypeError('Response lost'));
    const initial = mount();
    await screen.findByText('guid.initialMessage.uncertain');
    initial.unmount();
    mount();
    await screen.findByText('guid.initialMessage.uncertain');
    expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'common.edit' })).toBeNull();

    accepted = true;
    await act(async () => screen.getByRole('button', { name: 'guid.initialMessage.check' }).click());
    await waitFor(() => expect(screen.queryByText(input)).toBeNull());
    expect(sendMessageInvokeMock).toHaveBeenCalledTimes(1);
  });
});
