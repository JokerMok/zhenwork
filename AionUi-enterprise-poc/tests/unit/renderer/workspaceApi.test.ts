import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceApiError,
  enterpriseLoginRedirectPath,
  newIdempotencyKey,
  unwrapRc2Response,
  workspaceErrorCode,
  workspaceErrorTranslationKey,
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

  it('redirects only hosted enterprise web sessions back to enterprise login', () => {
    expect(enterpriseLoginRedirectPath(401, true)).toBe('/enterprise/login');
    expect(enterpriseLoginRedirectPath('SESSION_REVOKED', true)).toBe('/enterprise/login');
    expect(enterpriseLoginRedirectPath(401, false)).toBeNull();
    expect(enterpriseLoginRedirectPath(403, true)).toBeNull();
  });

  it('redirects an expired hosted RC2 envelope while still surfacing its error', () => {
    const replace = vi.fn();
    vi.stubGlobal('window', {
      __AION_ENTERPRISE_WEB__: true,
      location: { pathname: '/', replace },
    });
    try {
      expect(() => unwrapRc2Response({ code: 401, msg: 'expired', data: null })).toThrowError(
        new WorkspaceApiError('401', 'expired')
      );
      expect(replace).toHaveBeenCalledWith('/enterprise/login');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps authorization and model failures to actionable localized messages', () => {
    expect(workspaceErrorTranslationKey('HTTP_403', 'load')).toBe('workspace.errors.forbidden');
    expect(workspaceErrorTranslationKey('PermissionDenied', 'action')).toBe('workspace.errors.forbidden');
    expect(workspaceErrorTranslationKey('ModelUnavailable', 'action')).toBe('workspace.errors.noModel');
    expect(workspaceErrorTranslationKey('REQUEST_FAILED', 'load')).toBe('workspace.errors.load');
  });

  it('preserves the original conversation when an in-page request expires', () => {
    const replace = vi.fn();
    vi.stubGlobal('window', {
      __AION_ENTERPRISE_WEB__: true,
      location: { pathname: '/', hash: '#/conversation/original-chat', replace },
    });
    try {
      expect(() => unwrapRc2Response({ code: 401, msg: 'expired' })).toThrowError(WorkspaceApiError);
      expect(replace).toHaveBeenCalledWith('/enterprise/login#/conversation/original-chat');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
