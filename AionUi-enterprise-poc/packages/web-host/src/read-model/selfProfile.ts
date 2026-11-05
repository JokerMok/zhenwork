import type { EnterpriseActor, EnterpriseGatewayOptions } from '../enterprise-gateway.js';

type ControlRequest = NonNullable<EnterpriseGatewayOptions['controlRequest']>;
const RC2_PROFILE = '/system/user/profile';

export class SelfProfileError extends Error {
  constructor(
    readonly status: number,
    code: string
  ) {
    super(code);
  }
}

function displayField(value: unknown, limit: number): string {
  return typeof value === 'string'
    ? value
        .replace(/\p{Cc}/gu, '')
        .trim()
        .slice(0, limit)
    : '';
}

function safeAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.toString();
  } catch {
    /* Incomplete or unsafe avatar URL. */
  }
}

async function requestProfile(control: ControlRequest, actor: EnterpriseActor, nickname?: string): Promise<unknown> {
  const response = await control(actor, RC2_PROFILE, {
    method: nickname === undefined ? 'GET' : 'PUT',
    ...(nickname === undefined
      ? {}
      : {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nickName: nickname }),
        }),
    signal: AbortSignal.timeout(7000),
  });
  if (response.status === 401 || response.status === 403)
    throw new SelfProfileError(response.status, 'PROFILE_FORBIDDEN');
  const result = (await response.json()) as { code?: number; data?: unknown };
  if (result.code === 401 || result.code === 403) throw new SelfProfileError(result.code, 'PROFILE_FORBIDDEN');
  if (response.status >= 500 || (nickname === undefined && (!response.ok || result.code !== 200)))
    throw new SelfProfileError(502, 'PROFILE_UNAVAILABLE');
  if (!response.ok || result.code !== 200) throw new SelfProfileError(400, 'PROFILE_UPDATE_REJECTED');
  return result.data;
}

export async function readSelfProfile(control: ControlRequest, actor: EnterpriseActor) {
  const result = (await requestProfile(control, actor)) as {
    user?: { userId?: unknown; userName?: unknown; nickName?: unknown; deptName?: unknown; avatarUrl?: unknown };
    postGroup?: unknown;
  } | null;
  const user = result?.user;
  if (!user || String(user.userId) !== actor.userId) throw new SelfProfileError(502, 'PROFILE_IDENTITY_MISMATCH');
  const username = displayField(user.userName, 64);
  if (!username) throw new SelfProfileError(502, 'PROFILE_UNAVAILABLE');
  const avatarUrl = safeAvatar(user.avatarUrl);
  return {
    id: actor.userId,
    username,
    nickname: displayField(user.nickName, 30),
    department: displayField(user.deptName, 120),
    position: displayField(result?.postGroup, 240),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

export async function saveSelfProfile(control: ControlRequest, actor: EnterpriseActor, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1)
    throw new SelfProfileError(400, 'PROFILE_INVALID');
  const nickname = (value as { nickname?: unknown }).nickname;
  if (typeof nickname !== 'string' || nickname.length > 30 || /[<>\p{Cc}]/u.test(nickname))
    throw new SelfProfileError(400, 'PROFILE_INVALID');
  await requestProfile(control, actor, nickname.trim());
  return readSelfProfile(control, actor);
}
