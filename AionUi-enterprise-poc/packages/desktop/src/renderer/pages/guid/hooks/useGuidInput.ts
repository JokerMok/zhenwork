/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ChatFileRef, chatFileRefPath, localFileRef, uploadFileRef } from '@/common/types/chatFile';
import { useDragUpload } from '@/renderer/hooks/file/useDragUpload';
import { usePasteService } from '@/renderer/hooks/file/usePasteService';
import { allSupportedExts, type FileMetadata } from '@/renderer/services/FileService';
import { measureCaretTop, scrollCaretToLastLine } from '../utils/caretUtils';
import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from 'react';
import { readDraft, writeDraft } from '@/renderer/hooks/chat/employeeDraftStorage';
import { appendPromptToDraft } from '@/renderer/hooks/chat/useSendBoxDraft';
import type { Location } from 'react-router-dom';

export type GuidInputResult = {
  input: string;
  draftId?: string;
  discardDraft?: () => void;
  clearSentDraft?: () => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: ChatFileRef[];
  setFiles: React.Dispatch<React.SetStateAction<ChatFileRef[]>>;
  dir: string;
  setDir: React.Dispatch<React.SetStateAction<string>>;
  isInputFocused: boolean;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  handleFilesPasted: (pastedFiles: FileMetadata[]) => void;
  /** Device uploads (blob → managed dir): sent as `upload` refs. */
  handleFilesUploaded: (uploadedPaths: string[]) => void;
  /** Backend-machine picker paths (native/server-fs): sent as `local` refs. */
  handleFilesPicked: (pickedPaths: string[]) => void;
  handleRemoveFile: (targetPath: string) => void;
  handleTextareaFocus: () => void;
  handleTextareaBlur: () => void;
  onPaste: ReturnType<typeof usePasteService>['onPaste'];
  isFileDragging: boolean;
  dragHandlers: ReturnType<typeof useDragUpload>['dragHandlers'];
};

type PrefillState = {
  workspace?: string;
  prefillPrompt?: string;
  prefillFiles?: string[];
  preservePrefillDraft?: boolean;
};
type UseGuidInputOptions = {
  locationState: PrefillState | null;
  employeeDraft?: { scope: string; location: Pick<Location, 'key' | 'search'> };
};
type Draft = { input: string; files: ChatFileRef[]; dir: string; appendedPrefill?: string };
const emptyDraft: Draft = { input: '', files: [], dir: '' };

export const useGuidInput = ({ locationState, employeeDraft }: UseGuidInputOptions): GuidInputResult => {
  const scope = employeeDraft?.scope;
  const activeKey = scope && `enterprise:guid-draft:${scope}:active`;
  const route = employeeDraft?.location;
  const anchoredId = route && new URLSearchParams(route.search).get('draft');
  const newPrefill =
    !anchoredId && !!(locationState?.prefillPrompt || locationState?.prefillFiles?.length || locationState?.workspace);
  const appendPrefill = newPrefill && locationState?.preservePrefillDraft;
  const draftId =
    activeKey &&
    (anchoredId || (newPrefill && !appendPrefill ? route?.key : readDraft<string>(activeKey)) || 'default');
  const key = draftId && `enterprise:guid-draft:${scope}:entry:${draftId}`;
  const [, redraw] = useState(0);
  const snapshot = useRef<{ key: string | undefined; draft: Draft }>(undefined);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!snapshot.current || snapshot.current.key !== key) {
    snapshot.current = { key, draft: (key && readDraft<Draft>(key)) || emptyDraft };
  }
  let draft = snapshot.current.draft;
  if (key && newPrefill) {
    const saved = readDraft<Draft>(key);
    if (appendPrefill && draft.appendedPrefill !== route?.key) {
      draft = {
        ...draft,
        input: appendPromptToDraft(draft.input, locationState?.prefillPrompt || ''),
        appendedPrefill: route?.key,
      };
    } else if (!appendPrefill && !saved && draft === emptyDraft) {
      draft = {
        input: locationState?.prefillPrompt || '',
        files: (locationState?.prefillFiles ?? []).map(uploadFileRef),
        dir: locationState?.workspace || '',
      };
    }
  }

  useLayoutEffect(() => {
    if (!key || !activeKey || !draftId) return;
    snapshot.current = { key, draft };
    try {
      writeDraft(key, draft);
      writeDraft(activeKey, draftId);
    } catch {
      // The mounted draft remains editable if tab storage is unavailable.
    }
  }, [activeKey, draft, draftId, key]);

  const updateDraft = useCallback(
    (change: (previous: Draft) => Draft) => {
      const current = mounted.current && snapshot.current?.key === key;
      const previous = current ? snapshot.current?.draft : key ? readDraft<Draft>(key) : undefined;
      if (!previous) return;
      const next = change(previous);
      if (next === previous) return;
      if (key) {
        try {
          writeDraft(key, next);
        } catch {
          // Keep the current editor usable even if storage has reached quota.
        }
      }
      if (current) {
        snapshot.current = { key, draft: next };
        redraw((revision) => revision + 1);
      }
    },
    [key]
  );
  const setInput = useCallback(
    (value: SetStateAction<string>) => {
      updateDraft((previous) => ({ ...previous, input: typeof value === 'function' ? value(previous.input) : value }));
    },
    [updateDraft]
  );
  const setFiles = useCallback(
    (value: SetStateAction<ChatFileRef[]>) => {
      updateDraft((previous) => ({ ...previous, files: typeof value === 'function' ? value(previous.files) : value }));
    },
    [updateDraft]
  );
  const setDir = useCallback(
    (value: SetStateAction<string>) => {
      updateDraft((previous) => ({ ...previous, dir: typeof value === 'function' ? value(previous.dir) : value }));
    },
    [updateDraft]
  );
  const discardDraft = useCallback(
    () => updateDraft((previous) => ({ ...emptyDraft, appendedPrefill: previous.appendedPrefill })),
    [updateDraft]
  );
  const clearSentDraft = useCallback(
    () =>
      updateDraft((previous) =>
        JSON.stringify(previous) === JSON.stringify(draft)
          ? { ...emptyDraft, appendedPrefill: previous.appendedPrefill }
          : previous
      ),
    [draft, updateDraft]
  );

  useLayoutEffect(() => {
    if (!scope && locationState?.workspace) setDir(locationState.workspace);
  }, [scope, locationState, setDir]);

  // Handle pasted files (append mode to support multiple pastes)
  // Do NOT clear dir here: paste/drag should coexist with a selected workspace,
  // matching the dialog-upload path (handleFilesUploaded).
  const handleFilesPasted = useCallback(
    (pastedFiles: FileMetadata[]) => {
      // Paste/drag bytes are uploaded to the managed dir by the paste/drag hooks →
      // `upload` refs.
      const refs = pastedFiles.map((file) => uploadFileRef(file.path));
      setFiles((prevFiles) => [...prevFiles, ...refs]);
    },
    [setFiles]
  );

  // Device uploads (browser input → managed dir): append as `upload` refs.
  const handleFilesUploaded = useCallback(
    (uploadedPaths: string[]) => {
      setFiles((prevFiles) => [...prevFiles, ...uploadedPaths.map(uploadFileRef)]);
    },
    [setFiles]
  );

  // Backend-machine picker (native dialog / server-fs browse): append as `local`
  // refs — the path is already absolute on the backend host, sent as-is.
  const handleFilesPicked = useCallback(
    (pickedPaths: string[]) => {
      setFiles((prevFiles) => [...prevFiles, ...pickedPaths.map(localFileRef)]);
    },
    [setFiles]
  );

  const handleRemoveFile = useCallback(
    (targetPath: string) => {
      setFiles((prevFiles) => prevFiles.filter((ref) => chatFileRefPath(ref) !== targetPath));
    },
    [setFiles]
  );

  // Files are uploaded; Finder folders keep their local path for the first Agent turn.
  const { isFileDragging, dragHandlers } = useDragUpload({
    supportedExts: allSupportedExts,
    onFilesAdded: handleFilesPasted,
    onFoldersAdded: handleFilesPicked,
  });

  // Use shared PasteService integration (paste appends to existing files)
  const { onPaste, onFocus } = usePasteService({
    supportedExts: allSupportedExts,
    onFilesAdded: handleFilesPasted,
    onTextPaste: (text: string) => {
      const textarea = document.activeElement as HTMLTextAreaElement | null;
      if (textarea && textarea.tagName === 'TEXTAREA') {
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? start;
        const current_value = textarea.value;
        const newValue = current_value.slice(0, start) + text + current_value.slice(end);
        setInput(newValue);

        setTimeout(() => {
          const newPos = start + text.length;
          textarea.setSelectionRange(newPos, newPos);
          const caretTop = measureCaretTop(textarea, newPos);
          scrollCaretToLastLine(textarea, caretTop);
        }, 0);
      } else {
        setInput((prev) => prev + text);
      }
    },
  });

  const handleTextareaFocus = useCallback(() => {
    onFocus();
    setIsInputFocused(true);
  }, [onFocus]);

  const handleTextareaBlur = useCallback(() => {
    setIsInputFocused(false);
  }, []);

  return {
    input: draft.input,
    draftId: draftId || undefined,
    discardDraft: key ? discardDraft : undefined,
    clearSentDraft: key ? clearSentDraft : undefined,
    setInput,
    files: draft.files,
    setFiles,
    dir: draft.dir,
    setDir,
    isInputFocused,
    loading,
    setLoading,
    handleFilesPasted,
    handleFilesUploaded,
    handleFilesPicked,
    handleRemoveFile,
    handleTextareaFocus,
    handleTextareaBlur,
    onPaste,
    isFileDragging,
    dragHandlers,
  };
};
