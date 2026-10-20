import { describe, expect, it } from 'vitest';
import {
  WorkspaceApiError,
  newIdempotencyKey,
  unwrapRc2Response,
  workspaceErrorCode,
} from '../../../packages/desktop/src/renderer/pages/workspace/workspaceApi';

describe('enterprise workspace response handling', () => {
  it('returns data from a successful RC2 envelope', () => {
    expect(unwrapRc2Response({ code: 200, msg: 'ok', data: [{ id: 'one' }] })).toEqual([{ id: 'one' }]);
  });

  it('keeps non-RC2 same-origin responses intact', () => {
    expect(unwrapRc2Response({ files: [{ path: 'report.docx' }] })).toEqual({
      files: [{ path: 'report.docx' }],
    });
  });

  it('surfaces the RC2 error code and message', () => {
    expect(() => unwrapRc2Response({ code: 409, msg: 'VersionConflict', data: null })).toThrowError(
      new WorkspaceApiError('409', 'VersionConflict')
    );
    expect(workspaceErrorCode(new WorkspaceApiError('DENIED', 'No access'))).toBe('DENIED');
    expect(workspaceErrorCode(new Error('UPLOAD_FAILED'))).toBe('UPLOAD_FAILED');
    expect(workspaceErrorCode(new Error('unsafe free-form message'))).toBe('REQUEST_FAILED');
  });

  it('creates a fresh idempotency key for each write', () => {
    const first = newIdempotencyKey();
    const second = newIdempotencyKey();
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second).not.toBe(first);
  });
});
