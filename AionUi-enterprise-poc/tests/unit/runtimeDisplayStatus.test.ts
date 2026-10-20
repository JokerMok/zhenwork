import { expect, test } from 'vitest';

import {
  runtimeDisplayStatus,
  workspaceTaskDisplayStatus,
} from '../../packages/desktop/src/renderer/utils/ui/runtimeDisplayStatus';

test('shows waiting for the user only from an explicit confirmation signal', () => {
  expect(runtimeDisplayStatus({ state: 'waiting_confirmation', pending_confirmations: 0 })).toBe('waitingUser');
  expect(runtimeDisplayStatus({ state: 'idle', pending_confirmations: 1 })).toBe('waitingUser');
  expect(workspaceTaskDisplayStatus('pending', null)).toBe('pending');
  expect(workspaceTaskDisplayStatus('waiting', null)).toBe('waiting');
});

test('distinguishes preparation and processing without leaving failed warmup stuck', () => {
  expect(runtimeDisplayStatus({ state: 'starting' })).toBe('preparing');
  expect(runtimeDisplayStatus({ state: 'running', is_processing: true })).toBe('processing');
  expect(runtimeDisplayStatus({ state: 'starting' }, { warming: true, preparationFailed: true })).toBeNull();
});

test('normalizes only known task completion and processing states', () => {
  expect(workspaceTaskDisplayStatus('finished', null)).toBe('completed');
  expect(workspaceTaskDisplayStatus('running', null)).toBe('processing');
  expect(workspaceTaskDisplayStatus('failed', null)).toBe('failed');
  expect(workspaceTaskDisplayStatus('custom_state', null)).toBe('custom_state');
});
