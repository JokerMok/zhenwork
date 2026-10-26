import { TaskRunner } from './tasks/runner.js';
import { TaskError } from './tasks/types.js';
import type { TaskRuntime } from './tasks/integration.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import serveHandler from 'serve-handler';
import enLogin from '../../desktop/src/renderer/services/i18n/locales/en-US/login.json' with { type: 'json' };
import zhLogin from '../../desktop/src/renderer/services/i18n/locales/zh-CN/login.json' with { type: 'json' };
import { enterpriseCoreBase, enterpriseCoreHost, enterpriseProxyHost } from './enterprise-core-address.js';
import { OfficeStore, validateKnowledgeScope, type KnowledgeScope } from './office/office-store.js';
import { previewOfficeFile } from './office/preview/index.js';
import { enterpriseProfilePath, prepareEnterpriseProfile } from './enterprise-core.js';
import { readProfile } from './read-model/profile.js';
import { enterpriseBootstrapShell, enterpriseReadinessPage } from './enterprise-readiness-page.js';

// Only content-addressed, release-owned code/assets may use the browser cache.
// Authentication still runs before this handler; user data never enters it.
async function serveReleaseAsset(req: IncomingMessage, res: ServerResponse, staticDir: string): Promise<boolean> {
  const pathname = (req.url || '').split('?')[0];
  const match = /^\/assets\/([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css|svg|json|woff2?|png|jpe?g|webp|gif|ico))$/.exec(pathname);
  if (!match || !['GET', 'HEAD'].includes(req.method || '')) return false;
  const root = await realpath(staticDir);
  const filename = path.join(root, 'assets', match[1]);
  const allowed = async (file: string): Promise<boolean> => {
    try { return (await realpath(file)).startsWith(root + path.sep) && (await stat(file)).isFile(); }
    catch { return false; }
  };
  if (!(await allowed(filename))) { reply(res, 404, { error: 'NOT_FOUND' });return true; }
  const accepted = new Map<string, number>();
  for (const part of String(req.headers['accept-encoding'] || '').split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    if (!name) continue;
    const parameter = parameters.map((value) => value.trim()).find((value) => value.startsWith('q='));
    const quality = parameter ? Number(parameter.slice(2)) : 1;
    accepted.set(name.toLowerCase(), Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0);
  }
  const quality = (encoding: string): number => accepted.get(encoding) ?? accepted.get('*') ?? 0;
  let selected = filename;
  let encoding = '';
  for (const candidate of ['br', 'gzip'].sort((a, b) => quality(b) - quality(a))) {
    const compressed = filename + (candidate === 'br' ? '.br' : '.gz');
    if (quality(candidate) > 0 && (await allowed(compressed))) { selected = compressed;encoding = candidate;break; }
  }
  if (!encoding && (accepted.get('identity') ?? (accepted.get('*') === 0 ? 0 : 1)) === 0) {
    reply(res, 406, { error: 'ENCODING_NOT_ACCEPTABLE' });return true;
  }
  const file = await stat(selected);
  const etag = `W/"${match[1]}-${encoding || 'identity'}"`;
  res.setHeader('cache-control', 'private, max-age=31536000, immutable');
  res.setHeader('vary', 'Accept-Encoding');
  res.setHeader('etag', etag);
  res.setHeader('last-modified', file.mtime.toUTCString());
  res.setHeader('x-content-type-options', 'nosniff');
  if (encoding) res.setHeader('content-encoding', encoding);
  if (String(req.headers['if-none-match'] || '').split(',').map((value) => value.trim()).some((value) => value === etag || value === '*')) {
    res.writeHead(304);res.end();return true;
  }
  const types: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', json: 'application/json', woff: 'font/woff', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', ico: 'image/x-icon',
  };
  res.setHeader('content-type', types[match[2]]);
  res.setHeader('content-length', file.size);
  res.writeHead(200);
  if (req.method === 'HEAD') res.end();
  else await pipeline(createReadStream(selected), res).catch(() => res.destroy());
  return true;
}

export type EnterpriseResourceState = { state: 'ready' | 'pending' | 'refreshing'; reason?: 'TASK_ACTIVE' | 'CHECK_FAILED';
};
export type EnterpriseActor = { serverId: string; userId: string };
export type EnterpriseClientMetadata = { ipAddress: string; userAgent: string };
export type EnterpriseCore = { port: number; localToken: string; stop: () => Promise<void>; invalidated?: Promise<void>;
  /** Host-visible mount path for this actor's service workspace. */
  workspaceRoot?: string;
  /** Private actor-network IPv4, or loopback for local development. */
  host?: string;
  /** Address that Core uses for the Web Host's model/MCP capability proxies. */
  proxyHost?: '127.0.0.1' | 'model-gateway';
  /** A loopback tunnel into a Core that only joins its actor's internal network. */
  networkMode?: 'container';
  /** Host-local loopback on Docker Desktop, or the Linux docker0 gateway. */
  proxyBindHost?: string;
  /** Admit a newly started host proxy into the actor's bridge before Core uses it. */
  registerProxyPort?: (port: number) => Promise<void>;
  /** Revoke the route before a closed host port can be reused by another process. */
  unregisterProxyPort?: (port: number) => Promise<void>;
};
export type EnterpriseLogin = { actor: EnterpriseActor; username?: string; validate: () => Promise<boolean>;
  brand?: () => Promise<unknown>; close: () => Promise<void>;
};
export type EnterpriseGatewayOptions = {
  staticDir: string;
  /** Public HTTPS origin terminated by the trusted reverse proxy. */
  publicOrigin: string;
  port: number;
  login: (username: string, password: string, client: EnterpriseClientMetadata) => Promise<EnterpriseLogin>;
  /** Public RC2 display fields for the unauthenticated login page. */
  publicBrand?: () => Promise<unknown>;
  /** Reauthenticate the current credential and update only that identity through RC2. */
  changePassword?: (username: string, oldPassword: string, newPassword: string,
    client: EnterpriseClientMetadata) => Promise<void>;
  /** Only explicit employee control routes; RC2 credentials never enter the browser. */
  controlRequest?: (actor: EnterpriseActor, route: string, init: RequestInit) => Promise<Response>;
  profileRoot?: string;
  taskRuntime?: TaskRuntime;
  adminUrl?: string;
  refreshResources?: (actor: EnterpriseActor) => Promise<EnterpriseResourceState | void>;
  resourceStatus?: (actor: EnterpriseActor) => EnterpriseResourceState;
  /** Validate a desktop supervisor's existing RC2 cookie on the server. */
  resume?: (rc2Cookie: string) => Promise<EnterpriseLogin>;
  startCore: (actor: EnterpriseActor) => Promise<EnterpriseCore>;
  /** Issue or revoke one job-scoped RC2 grant after Core accepts a cron mutation. */
  syncCronGrant?: (actor: EnterpriseActor, jobId: string, enabled: boolean) => Promise<void>;
  hasBackgroundJobs?: (actor: EnterpriseActor) => boolean;
  /** Recheck a stored background grant with RC2 before retaining a Core. */
  authorizeBackground?: (actor: EnterpriseActor) => Promise<boolean>;
  /** A dormant scheduled job does not require an always-on employee worker. */
  backgroundDue?: (actor: EnterpriseActor) => Promise<boolean>;
  reconcileCronJobs?: (actor: EnterpriseActor) => Promise<void>;
  maxSessions?: number;
  maxCores?: number;
  /** Bound simultaneous Docker Core startups; queued starts are also bounded. */
  maxStartingCores?: number;
  maxQueuedCoreStarts?: number;
  coreStartWaitMs?: number;
  /** Reclaim an unused Core after this interval; zero disables idle reclamation. */
  coreIdleMs?: number;
  /** Shared only by the loopback Caddy boundary and this process; browsers never receive it. */
  trustedProxyToken?: string;
  /** Loopback browser smoke tests only; the production CLI never enables this. */
  allowInsecureLoopbackDev?: boolean;
};

type Session = EnterpriseLogin & {
  sockets: Set<Duplex>;
  requests: Set<http.ClientRequest>;
  responses: Set<ServerResponse>;
  expiresAt: number;
  validating?: Promise<boolean>;
};
class CoreCapacityError extends Error {}
type PreparationPhase = 'queued' | 'starting' | 'ready';
type PreparationAttempt = { traceId: string; startedAt: number; phase: PreparationPhase; phaseStartedAt: number;
  trace: Array<{ phase: PreparationPhase | 'failed'; atMs: number }>; outcomeLogged?: true;
};
type PreparationFailure = { error: 'AUTHENTICATION_REQUIRED' | 'CAPABILITY_FORBIDDEN' |
  'DEFAULT_MODEL_UNAVAILABLE' | 'CORE_START_FAILED';
  attempt: PreparationAttempt; failedAt: number;
};
const COOKIE_NAME = '__Host-aion-enterprise-web';
const DEV_COOKIE_NAME = 'aion-enterprise-web-dev';
// Core creates conversation IDs with generate_short_id() (8 hex chars), while
// imported or older conversations may have full UUID IDs.
const isConversationId = (value: unknown): value is string => typeof value === 'string' &&
  (/^[0-9a-f]{8}$/i.test(value) || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
const SESSION_MS = 8 * 60 * 60 * 1000;
// Private WebSocket close code: the browser waits for the next user action
// before reconnecting, so an idle Core does not restart immediately.
const IDLE_CORE_WS_CLOSE = Buffer.from([0x88, 0x02, 0x0f, 0xa1]); // 4001
const MAX_BODY = 50 * 1024 * 1024;
const LOGIN_BODY = 4096;
const MAX_PROVIDER_RESPONSE = 2 * 1024 * 1024;

// These POST endpoints inspect or release runtime state; they are not execution intent.
function passiveWorkerRequest(method: string, url: string): boolean {
  if (['GET', 'HEAD'].includes(method)) return true;
  const route = url.split('?')[0];
  return (
    method === 'POST' && (
    /^\/api\/fs\/(dir|list|read|metadata|content|content\/metadata|image-base64)$/.test(route) ||
    route === '/api/shell/check-tool-installed' ||
    /^\/api\/conversations\/[^/]+\/runtime\/ensure$/.test(route) ||
    /^\/api\/(word|excel|ppt)-preview\/stop$/.test(route) ||
    /^\/api\/extensions\/(i18n|permissions|risk-level)$/.test(route))
  );
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function loopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '::1' || (net.isIP(normalized) === 4 && normalized.startsWith('127.'));
}

function clientMetadata(req: IncomingMessage, trustedProxyToken?: string): EnterpriseClientMetadata | null {
  const peer = req.socket.remoteAddress;
  if (!loopbackPeer(peer)) return null;
  if (!trustedProxyToken) {
    const address = peer?.startsWith('::ffff:') ? peer.slice(7) : peer;
    return address ? { ipAddress: address, userAgent: req.headers['user-agent'] || 'Unknown' } : null;
  }
  const token = req.headers['x-zhenwork-edge-token'];
  const ipAddress = req.headers['x-zhenwork-client-ip'];
  const userAgent = req.headers['x-zhenwork-client-user-agent'];
  if (typeof token !== 'string' || !sameSecret(token, trustedProxyToken) ||
      typeof ipAddress !== 'string' || net.isIP(ipAddress) === 0 ||
      typeof userAgent !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(userAgent)) return null;
  return { ipAddress, userAgent };
}

type LoginBrand = {
  productName: string; companyName: string; loginTitle: string; loginSubtitle: string;
  supportText: string; copyright: string; primaryColor: string; logoDataUrl: string;
};

function loginBrand(value: unknown): LoginBrand | null {
  if (!value || typeof value !== 'object') return null;
  const brand = value as Record<string, unknown>;
  const field = (name: string, max: number): string =>
    typeof brand[name] === 'string' ? brand[name].trim().slice(0, max) : '';
  const productName = field('productName', 80);
  if (!productName) return null;
  const color = field('primaryColor', 7);
  const logo = field('logoDataUrl', 2_800_000);
  return {
    productName,
    companyName: field('companyName', 100),
    loginTitle: field('loginTitle', 100),
    loginSubtitle: field('loginSubtitle', 300),
    supportText: field('supportText', 300),
    copyright: field('copyright', 200),
    primaryColor: /^#[0-9a-f]{6}$/i.test(color) ? color : '#2563eb',
    logoDataUrl: /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(logo) ? logo : '',
  };
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[char] || char);
}

function contrastingInk(hex: string): '#15243a' | '#ffffff' {
  const channels = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.19 ? '#15243a' : '#ffffff';
}

function loginPage(brand: LoginBrand | null, english: boolean, nonce: string): string {
  const copy = english ? enLogin : zhLogin;
  const language = english ? 'en' : 'zh-CN';
  const product = brand?.productName || copy.brand;
  const title = brand?.loginTitle || copy.submit;
  const subtitle = brand?.loginSubtitle ?? copy.subtitle;
  const color = brand?.primaryColor || '#2563eb';
  const ink = contrastingInk(color);
  const logo = brand?.logoDataUrl
    ? `<img class="brand-logo" src="${brand.logoDataUrl}" alt="${html(product)}" width="56" height="56">`
    : `<span class="brand-logo brand-initial" aria-hidden="true">${html(product.slice(0, 1))}</span>`;
  const feedback = JSON.stringify({
    submitting: copy.submitting,
    invalid: copy.errors.invalidCredentials,
    busy: copy.errors.tooManyAttempts,
    unavailable: copy.errors.serverError,
    network: copy.errors.networkError,
    passwordRequired: english ? 'Set a new password before continuing.' : '请先设置新密码，再进入工作台。',
    newPassword: english ? 'New password (8–16 letters and digits)' : '新密码（8–16位字母和数字）',
    confirmPassword: english ? 'Confirm new password' : '确认新密码',
    passwordRule: english ? 'Use 8–16 characters with both letters and digits.' : '密码须为8–16位，且同时包含字母和数字。',
    mismatch: english ? 'The two passwords do not match.' : '两次输入的密码不一致。',
    passwordUpdate: english ? 'Set password and sign in' : '设置密码并登录',
    passwordFailed: english ? 'Password could not be updated. Check the current password and try again.' : '未能更新密码，请检查当前密码后重试。',
    login: copy.submit,
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${html(product)} · ${html(title)}</title><style nonce="${nonce}">
:root{--brand:${color};--brand-ink:${ink};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;color:#1a2b42;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:clamp(16px,4vw,48px)}::selection{background:var(--brand);color:var(--brand-ink)}.shell{width:min(100%,960px);min-height:560px;display:grid;grid-template-columns:minmax(300px,.92fr) minmax(380px,1fr);overflow:hidden;border-radius:20px;background:#fff;box-shadow:0 24px 70px -32px rgba(18,36,65,.36)}.brand-side{display:flex;flex-direction:column;justify-content:space-between;gap:48px;padding:clamp(30px,4vw,52px);background:var(--brand);color:var(--brand-ink)}.brand-top{display:flex;align-items:center;gap:14px;min-width:0}.brand-logo{width:56px;height:56px;flex:none;object-fit:contain;border-radius:14px;background:#fff;padding:6px}.brand-initial{display:grid;place-items:center;color:#1a2b42;font-size:30px;font-weight:700}.company{font-size:14px;font-weight:650;line-height:1.5;overflow-wrap:anywhere}.brand-name{max-width:12ch;margin:0;font-size:clamp(32px,4vw,48px);line-height:1.16;letter-spacing:-.025em;overflow-wrap:anywhere}.brand-footer{font-size:13px;line-height:1.6;opacity:.85;overflow-wrap:anywhere}.form-side{display:flex;flex-direction:column;justify-content:center;padding:clamp(30px,6vw,70px)}h1{margin:0 0 12px;font-size:clamp(27px,3vw,34px);line-height:1.25;letter-spacing:-.025em;overflow-wrap:anywhere}.subtitle{margin:0 0 38px;color:#52647c;font-size:15px;line-height:1.7;overflow-wrap:anywhere}form{display:grid;gap:20px}label{display:grid;gap:8px;font-size:14px;font-weight:650}input{width:100%;min-height:48px;padding:12px 14px;border:1px solid #b9c6d5;border-radius:10px;background:#fff;color:#1a2b42;font:inherit;font-weight:400;outline:none;transition:border-color .15s,box-shadow .15s}input:hover{border-color:#6e8098}input:focus-visible{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 20%,transparent)}button{min-height:48px;margin-top:8px;border:0;border-radius:10px;background:var(--brand);color:var(--brand-ink);font:inherit;font-weight:700;cursor:pointer;transition:filter .15s,transform .15s}button:hover{filter:brightness(.94)}button:active{transform:translateY(1px)}button:focus-visible{outline:3px solid #1a2b42;outline-offset:3px}button:disabled{cursor:wait;opacity:.68;transform:none}[hidden]{display:none!important}.notice{color:#52647c;font-size:14px;line-height:1.6;margin:0 0 20px}.error{min-height:22px;margin:16px 0 0;color:#a02d2d;font-size:14px;line-height:1.6}.support{margin:24px 0 0;color:#52647c;font-size:13px;line-height:1.6;overflow-wrap:anywhere}@media(max-width:760px){body{display:block;padding:0;background:#fff}.shell{display:block;min-height:100dvh;border-radius:0;box-shadow:none}.brand-side{gap:28px;padding:26px 24px 30px}.brand-name{max-width:none;font-size:29px}.brand-footer{display:none}.form-side{padding:36px 24px 48px;max-width:520px;margin:auto}.subtitle{margin-bottom:30px}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{transition:none!important}}
</style></head><body><main class="shell"><section class="brand-side" aria-label="${html(product)}"><div class="brand-top">${logo}${brand?.companyName ? `<span class="company">${html(brand.companyName)}</span>` : ''}</div><p class="brand-name">${html(product)}</p>${brand?.copyright ? `<div class="brand-footer">${html(brand.copyright)}</div>` : '<div></div>'}</section><section class="form-side"><h1>${html(title)}</h1>${subtitle ? `<p class="subtitle">${html(subtitle)}</p>` : ''}<p id="notice" class="notice" hidden role="status"></p><form id="login"><label for="username">${html(copy.enterpriseAccountLabel)}<input id="username" name="username" autocomplete="username" required maxlength="100"></label><label for="password">${html(copy.password)}<input id="password" name="password" type="password" autocomplete="current-password" required></label><label id="new-password-label" for="new-password" hidden>${html(english ? 'New password (8–16 letters and digits)' : '新密码（8–16位字母和数字）')}<input id="new-password" name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="16" pattern="(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,16}" disabled></label><label id="confirm-password-label" for="confirm-password" hidden>${html(english ? 'Confirm new password' : '确认新密码')}<input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" maxlength="16" disabled></label><button id="submit" type="submit">${html(copy.submit)}</button></form><p id="error" class="error" role="alert" aria-live="polite"></p>${brand?.supportText ? `<p class="support">${html(brand.supportText)}</p>` : ''}</section></main><script nonce="${nonce}">const copy=${feedback};
const form=document.getElementById('login');const button=document.getElementById('submit');const error=document.getElementById('error');const notice=document.getElementById('notice');let changing=false;
function passwordMode(enabled){changing=enabled;notice.hidden=!enabled;notice.textContent=enabled?copy.passwordRequired:'';for(const id of ['new-password','confirm-password']){const input=document.getElementById(id);input.disabled=!enabled;input.required=enabled;document.getElementById(id+'-label').hidden=!enabled;}button.textContent=enabled?copy.passwordUpdate:copy.login;}
async function send(route,data){return fetch(route,{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify(data)});}
form.addEventListener('submit',async(event)=>{event.preventDefault();error.textContent='';button.disabled=true;button.textContent=copy.submitting;try{const fields=new FormData(form);const data={username:fields.get('username'),password:fields.get('password')};if(changing){const next=fields.get('newPassword');if(!/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,16}$/.test(next)){error.textContent=copy.passwordRule;return;}if(next!==fields.get('confirmPassword')){error.textContent=copy.mismatch;return;}const changed=await send('/enterprise/password',{...data,newPassword:next});if(!changed.ok){error.textContent=changed.status===429?copy.busy:copy.passwordFailed;return;}data.password=next;document.getElementById('password').value=next;document.getElementById('new-password').value='';document.getElementById('confirm-password').value='';passwordMode(false);}const response=await send('/enterprise/login',data);if(response.ok){location.replace('/');return;}const result=await response.json().catch(()=>({}));if(response.status===409&&result.error==='PASSWORD_CHANGE_REQUIRED'){passwordMode(true);document.getElementById('new-password').focus();return;}error.textContent=response.status===401?copy.invalid:response.status===429?copy.busy:copy.unavailable;}catch{error.textContent=copy.network;}finally{button.disabled=false;button.textContent=changing?copy.passwordUpdate:copy.login;}});</script></body></html>`;
}

function providerRoute(url: string): boolean {
  return /^\/api\/providers(?:\/|\?|$)/.test(url);
}

function mcpServerRoute(url: string): boolean {
  return /^\/api\/mcp\/(?:servers|agent-configs)(?:\/|\?|$)/.test(url);
}

function clientSettingsRoute(url: string): boolean {
  return /^\/api\/settings\/client(?:\?|$)/.test(url);
}

function urlMayContainCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password || url.search || url.hash);
  } catch {
    // Do not return an unparseable stored endpoint to the browser.
    return true;
  }
}

function scrubProviderSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubProviderSecrets);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key === 'api_key' && typeof item === 'string') {
      result.api_key = '';
      result.api_key_configured = item.length > 0;
      result.api_key_count = item.split(/[,\n]/).filter((part) => part.trim()).length;
    } else if (key === 'base_url' && typeof item === 'string' && item && urlMayContainCredentials(item)) {
      result.base_url = '';
      result.base_url_configured = item.length > 0;
    } else if (key === 'secret_access_key' && typeof item === 'string') {
      result.secret_access_key = '';
      result.secret_access_key_configured = item.length > 0;
    } else if (key === 'access_key_id' && typeof item === 'string') {
      result.access_key_id = '';
      result.access_key_id_configured = item.length > 0;
    } else {
      result[key] = scrubProviderSecrets(item);
    }
  }
  return result;
}

function scrubMcpServerSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubMcpServerSecrets);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key === 'original_json') {
      result[key] = '';
    } else if (key === 'transport' && item && typeof item === 'object') {
      const transport = item as Record<string, unknown>;
      // MCP arguments, environment, URLs and headers may all contain tokens.
      result[key] = transport.type === 'stdio'
        ? { type: 'stdio', command: '', args: [], env: {}, credentials_configured: true }
        : { type: transport.type, url: '', headers: {}, credentials_configured: true };
    } else {
      result[key] = scrubMcpServerSecrets(item);
    }
  }
  return result;
}

function scrubClientSettings(value: unknown): unknown {
  const cleaned = scrubProviderSecrets(value) as { data?: Record<string, unknown> } | null;
  if (cleaned?.data && Object.hasOwn(cleaned.data, 'mcp.config')) {
    cleaned.data['mcp.config'] = scrubMcpServerSecrets(cleaned.data['mcp.config']);
  }
  const google = cleaned?.data?.['google.config'];
  if (google && typeof google === 'object' && !Array.isArray(google)) {
    const settings = google as Record<string, unknown>;
    if (typeof settings.proxy === 'string') {
      settings.proxy_configured = settings.proxy.length > 0;
      settings.proxy = '';
    }
  }
  return cleaned;
}

function mergeClientSettingsSecrets(next: unknown, previous: unknown): unknown {
  if (Array.isArray(next)) {
    const old = Array.isArray(previous) ? previous : [];
    return next.map((item, index) => {
      const prior = item && typeof item === 'object' && 'id' in item
        ? old.find((candidate) => candidate && typeof candidate === 'object' && candidate.id === item.id)
        : old[index];
      return mergeClientSettingsSecrets(item, prior);
    });
  }
  if (!next || typeof next !== 'object') return next;
  const object = next as Record<string, unknown>;
  const old = previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (key.endsWith('_configured') || key === 'credentials_configured' || key === 'api_key_count') continue;
    if (['api_key', 'base_url', 'secret_access_key', 'access_key_id', 'proxy'].includes(key) && value === '' &&
        object[`${key}_configured`] === true && typeof old[key] === 'string') {
      merged[key] = old[key];
    } else if (key === 'transport' && value && typeof value === 'object' &&
        (value as Record<string, unknown>).credentials_configured === true &&
        !((value as Record<string, unknown>).url || (value as Record<string, unknown>).command)) {
      merged[key] = old[key] ?? value;
    } else {
      merged[key] = mergeClientSettingsSecrets(value, old[key]);
    }
  }
  return merged;
}

function actorKey(actor: EnterpriseActor): string {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(actor.serverId) || !/^[0-9]{1,20}$/.test(actor.userId)) {
    throw new Error('Invalid enterprise actor');
  }
  return `${actor.serverId}:${actor.userId}`;
}

function withinDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function scopedDirectoryEntries(value: unknown, root: string): Promise<Array<Record<string, unknown>>> {
  if (!Array.isArray(value)) throw new Error('Invalid Core directory response');
  const candidates = await Promise.all(value.map(async (raw): Promise<Record<string, unknown> | null> => {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || typeof item.full_path !== 'string' ||
        typeof item.is_dir !== 'boolean') return null;
    const resolved = await realpath(item.full_path).catch((): null => null);
    if (!resolved || !withinDirectory(resolved, root)) return null;
    return { name: item.name, full_path: item.full_path,
      relative_path: path.relative(root, resolved), is_dir: item.is_dir, is_file: !item.is_dir,
      ...(Array.isArray(item.children) ? { children: await scopedDirectoryEntries(item.children, root) } : {}),
      };
  }));
  return candidates.filter((item): item is Record<string, unknown> => item !== null);
}

function sessionId(req: IncomingMessage, cookieName: string): string | undefined {
  const pair = req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  const value = pair?.slice(cookieName.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

function body(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (part: Buffer) => {
      size += part.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
      } else chunks.push(part);
    });
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', reject);
  });
}

function reply(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function replyCoreFailure(res: ServerResponse, error: unknown): void {
  if (error instanceof CoreCapacityError) {
    res.setHeader('retry-after', '5');
    reply(res, 503, { error: 'CORE_CAPACITY' });
  } else if (error instanceof Error && 'code' in error && error.code === 'AUTHENTICATION_REQUIRED') {
    reply(res, 401, { error: 'AUTHENTICATION_REQUIRED' });
  } else if (error instanceof Error && 'code' in error && error.code === 'CAPABILITY_FORBIDDEN') {
    reply(res, 403, { error: 'CAPABILITY_FORBIDDEN' });
  } else reply(res, 503, { error: 'CORE_UNAVAILABLE' });
}

function proxyHeaders(req: IncomingMessage, core: EnterpriseCore): http.OutgoingHttpHeaders {
  const headers = { ...req.headers };
  delete headers.cookie;
  delete headers.authorization;
  delete headers['x-aion-enterprise-local-token'];
  delete headers['x-forwarded-for'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  headers.host = `${enterpriseCoreHost(core)}:${core.port}`;
  headers.origin = enterpriseCoreBase(core);
  headers['x-aion-enterprise-local-token'] = core.localToken;
  if (req.url && (providerRoute(req.url) || mcpServerRoute(req.url) || clientSettingsRoute(req.url))) {
    headers['accept-encoding'] = 'identity';
  }
  return headers;
}

/**
 * HTTPS must terminate at a trusted proxy. This listener binds to loopback only.
 * Login and validation are supplied by the RC2 adapter; one authenticated actor
 * is routed to one server-side Core. No browser cookie or Core token crosses
 * the proxy boundary.
 */
export async function startEnterpriseGateway(
  opts: EnterpriseGatewayOptions
): Promise<{ port: number; stop: () => Promise<void>;
  reconcileAuthorization: () => Promise<void>;
  reapIdleCores: () => Promise<void>;
  capacity: () => { sessions: number; pendingSessions: number; cores: number;
    starting: number; queuedStarts: number };
  startBackgroundCore: (actor: EnterpriseActor) => Promise<void>;
}> {
  const origin = new URL(opts.publicOrigin);
  const localDev = opts.allowInsecureLoopbackDev === true && origin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(origin.hostname);
  const cookieName = localDev ? DEV_COOKIE_NAME : COOKIE_NAME;
  if ((!localDev && origin.protocol !== 'https:') || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Enterprise web requires a fixed HTTPS origin');
  }
  const sessions = new Map<string, Session>();
  type CoreEntry = {
    actor: EnterpriseActor;
    started: Promise<EnterpriseCore>;
    lastUsed: number;
    ready: boolean;
    admitted: boolean;
    idleBlock?: string;
    abort: AbortController;
    preparation: PreparationAttempt;
  };
  const cores = new Map<string, CoreEntry>();
  const stopping = new Map<string, Promise<void>>();
  const preparationAttempts = new Map<string, PreparationAttempt>();
  const preparationFailures = new Map<string, PreparationFailure>();
  const maxSessions = opts.maxSessions ?? 100;
  const maxCores = opts.maxCores ?? 50;
  const maxStartingCores = opts.maxStartingCores ?? 4;
  const maxQueuedCoreStarts = opts.maxQueuedCoreStarts ?? 20;
  const coreStartWaitMs = opts.coreStartWaitMs ?? 120_000;
  const coreIdleMs = opts.coreIdleMs ?? 10 * 60_000;
  if (![maxSessions, maxCores, maxStartingCores, coreStartWaitMs].every((value) =>
    Number.isSafeInteger(value) && value > 0) ||
    ![maxQueuedCoreStarts, coreIdleMs].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Enterprise Core capacity configuration invalid');
  }
  let starting = 0;
  let occupied = 0;
  let pendingSessions = 0;
  type StartWaiter = { resolve: () => void; reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>; signal: AbortSignal; onAbort: () => void;
  };
  const queuedStarts: StartWaiter[] = [];
  let shuttingDown = false;
  const preparationFor = (key: string): PreparationAttempt => {
    const existing = preparationAttempts.get(key);
    if (existing) return existing;
    const now = Date.now();
    const attempt: PreparationAttempt = { traceId: randomBytes(8).toString('hex'),
      startedAt: now, phase: 'queued', phaseStartedAt: now,
      trace: [{ phase: 'queued', atMs: 0 }],
    };
    preparationAttempts.set(key, attempt);
    return attempt;
  };
  const transitionPreparation = (attempt: PreparationAttempt, phase: PreparationPhase): void => {
    if (attempt.phase === phase) return;
    const now = Date.now();
    attempt.phase = phase;attempt.phaseStartedAt = now;
    attempt.trace.push({ phase, atMs: now - attempt.startedAt });
  };
  const preparationTimings = (attempt: PreparationAttempt, endedAt: number): Record<string, number> => {
    const totalMs = endedAt - attempt.startedAt;
    const timings: Record<string, number> = { totalMs };
    for (let index = 0; index < attempt.trace.length; index += 1) {
      const current = attempt.trace[index];
      if (!current || current.phase === 'failed') continue;
      const next = attempt.trace[index + 1];
      timings[`${current.phase}Ms`] = Math.max(0, (next?.atMs ?? totalMs) - current.atMs);
    }
    return timings;
  };
  const logPreparationOutcome = (attempt: PreparationAttempt, outcome: 'success' | 'failure',
    code: PreparationFailure['error'] | 'READY', endedAt: number): void => {
    if (attempt.outcomeLogged) return;
    attempt.outcomeLogged = true;
    const entry = JSON.stringify({ event: 'enterprise_core_initialization', outcome,
      traceId: attempt.traceId, phase: outcome === 'success' ? 'ready' : 'failed',
      timings: preparationTimings(attempt, endedAt), code,
    });
    if (outcome === 'success') console.info('[Enterprise preparation]', entry);
    else console.warn('[Enterprise preparation]', entry);
  };
  const preparationError = (error: unknown): PreparationFailure['error'] => {
    if (error instanceof Error && 'code' in error && error.code === 'AUTHENTICATION_REQUIRED')
      return 'AUTHENTICATION_REQUIRED';
    if (error instanceof Error && 'code' in error && error.code === 'CAPABILITY_FORBIDDEN')
      return 'CAPABILITY_FORBIDDEN';
    if (error instanceof Error && error.message === 'DEFAULT_MODEL_UNAVAILABLE')
      return 'DEFAULT_MODEL_UNAVAILABLE';
    return 'CORE_START_FAILED';
  };
  const recordPreparationFailure = (key: string, attempt: PreparationAttempt, error: unknown): void => {
    if (error instanceof CoreCapacityError || shuttingDown) return;
    const failedAt = Date.now();
    if (attempt.trace.at(-1)?.phase !== 'failed')
      attempt.trace.push({ phase: 'failed', atMs: failedAt - attempt.startedAt });
    const safeError = preparationError(error);
    preparationFailures.set(key, { error: safeError, attempt, failedAt });
    logPreparationOutcome(attempt, 'failure', safeError, failedAt);
  };
  const preparationPayload = (attempt: PreparationAttempt, now = Date.now()) => ({
    traceId: attempt.traceId,
    phase: attempt.phase,
    timings: { totalMs: now - attempt.startedAt, phaseMs: now - attempt.phaseStartedAt },
    trace: attempt.trace,
  });
  const acquireStart = async (signal: AbortSignal): Promise<void> => {
    if (shuttingDown || signal.aborted) throw new Error('Enterprise Core startup cancelled');
    if (starting < maxStartingCores && occupied < maxCores) {
      starting += 1;
      occupied += 1;
      return;
    }
    if (queuedStarts.length >= maxQueuedCoreStarts) throw new CoreCapacityError('Core startup queue is full');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = queuedStarts.indexOf(waiter);
        if (index >= 0) queuedStarts.splice(index, 1);
        clearTimeout(waiter.timeout);
        reject(new Error('Enterprise Core startup cancelled'));
      };
      const waiter: StartWaiter = { resolve, reject, signal, onAbort, timeout: setTimeout(() => {
        const index = queuedStarts.indexOf(waiter);
        if (index >= 0) queuedStarts.splice(index, 1);
        signal.removeEventListener('abort', onAbort);
        reject(new CoreCapacityError('Core startup wait timed out'));
      }, coreStartWaitMs),
      };
      waiter.timeout.unref();
      queuedStarts.push(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const advanceStarts = (): void => {
    while (starting < maxStartingCores && occupied < maxCores && queuedStarts.length) {
      const next = queuedStarts.shift()!;
      clearTimeout(next.timeout);
      next.signal.removeEventListener('abort', next.onAbort);
      starting += 1;
      occupied += 1;
      next.resolve();
    }
  };
  const releaseStart = (): void => {
    starting -= 1;
    advanceStarts();
  };
  const loginAttempts: number[] = [];
  const authorizedBackground = async (actor: EnterpriseActor): Promise<boolean> =>
    opts.hasBackgroundJobs?.(actor) === true &&
    (!opts.authorizeBackground || (await opts.authorizeBackground(actor).catch(() => false)));
  const stopCore = async (key: string): Promise<void> => {
    const entry = cores.get(key);
    if (!entry) return;
    cores.delete(key);
    preparationAttempts.delete(key);
    preparationFailures.delete(key);
    entry.abort.abort();
    const done = entry.started.then((core) => core.stop(), () => {});
    stopping.set(key, done);
    try {
      await done;
      if (entry.admitted) {
        entry.admitted = false;
        occupied -= 1;
        advanceStarts();
      }
    } finally { if (stopping.get(key) === done) stopping.delete(key); }
  };

  const actorSessions = (key: string): Session[] => [...sessions.values()].filter((session) =>
    actorKey(session.actor) === key);
  const idleCandidate = (key: string, entry: CoreEntry, allowSockets = false): boolean => coreIdleMs > 0 &&
    cores.get(key) === entry && entry.ready && Date.now() - entry.lastUsed >= coreIdleMs &&
    !actorSessions(key).some((session) => session.responses.size > 0 ||
      (!allowSockets && session.sockets.size > 0));
  const closeIdleSocket = (socket: Duplex): Promise<void> => new Promise((resolve) => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
    timer.unref();
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.end(IDLE_CORE_WS_CLOSE);
  });
  const stopIdleCore = async (key: string, entry: CoreEntry): Promise<boolean> => {
    const blocked = (reason: string): false => {
      if (entry.ready && Date.now() - entry.lastUsed >= coreIdleMs && entry.idleBlock !== reason) {
        entry.idleBlock = reason;
        console.info('[Enterprise Core]', JSON.stringify({event:'idle_reclaim_deferred', reason,
          actorHash:createHash('sha256').update(key).digest('hex').slice(0,16),
          idleMs:Date.now()-entry.lastUsed,
          responses:actorSessions(key).reduce((n,s)=>n+s.responses.size,0),
          sockets:actorSessions(key).reduce((n,s)=>n+s.sockets.size,0)}));
      }
      return false;
    };
    if (!idleCandidate(key, entry, true)) return blocked('inflight_response');
    if (
      opts.hasBackgroundJobs?.(entry.actor) &&
      (!opts.backgroundDue || (await opts.backgroundDue(entry.actor).catch(() => true)))
    )
      return false;
    let idle = false;
    try {
      const core = await entry.started;
      const response = await fetch(`${enterpriseCoreBase(core)}/api/cron/internal/idle-ready`, {
        headers: { 'x-aion-enterprise-local-token': core.localToken, 'x-aionui-internal': '1' },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 10_000) return false;
      const raw = await response.text();
      if (raw.length > 10_000) return false;
      const body = JSON.parse(raw) as { success?: boolean; data?: { idle?: unknown } };
      idle = body.success === true && body.data?.idle === true;
    } catch { return false; }
    // The worker checks running turns, background children and team coordinators.
    if (!idle || !idleCandidate(key, entry, true)) return blocked(idle ? 'activity_changed' : 'native_safety_busy');
    await Promise.all(actorSessions(key).flatMap((session) => [...session.sockets].map(closeIdleSocket)));
    if (!idleCandidate(key, entry)) return false;
    await stopCore(key);
    return true;
  };
  const reclaimIdleCores = async (stopAfterOne: boolean): Promise<void> => {
    const candidates = [...cores].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    if (stopAfterOne) {
      for (const [key, entry] of candidates) {
        if (await stopIdleCore(key, entry)) return;
      }
      return;
    }
    for (let index = 0; index < candidates.length; index += 8) {
      await Promise.allSettled(candidates.slice(index, index + 8)
        .map(([key, entry]) => stopIdleCore(key, entry)));
    }
  };
  const reapIdleCores = (): Promise<void> => reclaimIdleCores(false);

  const validOrigin = (req: IncomingMessage, unsafe: boolean): boolean => {
    if (req.headers.host !== origin.host) return false;
    return !unsafe || req.headers.origin === origin.origin;
  };
  const closeSessionConnections = (session: Session): void => {
    for (const socket of session.sockets) socket.destroy();
    for (const request of session.requests) request.destroy();
    for (const response of session.responses) response.destroy();
  };
  const revoke = async (id: string): Promise<boolean> => {
    const session = sessions.get(id);
    if (!session) return true;
    sessions.delete(id);
    closeSessionConnections(session);
    const key = actorKey(session.actor);
    const last = ![...sessions.values()].some((other) => actorKey(other.actor) === key);
    let backgroundReady = true;
    if (last && cores.has(key) && opts.reconcileCronJobs) {
      try { await opts.reconcileCronJobs(session.actor); }
      catch { backgroundReady = false; }
    }
    await session.close().catch(() => {});
    if (last) {
      preparationAttempts.delete(key);
      preparationFailures.delete(key);
    }
    if (last && !(await authorizedBackground(session.actor))) {
      try { await stopCore(key); }
      catch { backgroundReady = false; }
    }
    return backgroundReady;
  };
  const validateSession = (session: Session): Promise<boolean> => {
    if (session.validating) return session.validating;
    const pending = session.validate().catch(() => false).finally(() => {
      if (session.validating === pending) session.validating = undefined;
    });
    session.validating = pending;
    return pending;
  };
  const authenticate = async (req: IncomingMessage): Promise<{ id: string; session: Session } | null> => {
    const id = sessionId(req, cookieName);
    const session = id && sessions.get(id);
    if (!id || !session) return null;
    if (session.expiresAt < Date.now() || !(await validateSession(session))) {
      await revoke(id);
      return null;
    }
    if (sessions.get(id) !== session) return null;
    return { id, session };
  };
  const getCore = async (actor: EnterpriseActor, allowBackground = false, activity = true, source = 'user_operation'): Promise<EnterpriseCore> => {
    const key = actorKey(actor);
    await stopping.get(key);
    if (
      ![...sessions.values()].some((session) => actorKey(session.actor) === key) &&
      !(allowBackground && (await authorizedBackground(actor)))
    ) {
            throw new Error('Employee session closed');
          }
    const preparation = preparationFor(key);
    let entry = cores.get(key);
    if (!entry) {
      const abort = new AbortController();
      console.info('[Enterprise Core]', JSON.stringify({ event: 'core_requested', source,
        actorHash: createHash('sha256').update(key).digest('hex').slice(0, 16), traceId: preparation.traceId,
        }));
      const started = (async () => {
        if (occupied >= maxCores) await reclaimIdleCores(true);
        await acquireStart(abort.signal);
        if (entry) entry.admitted = true;
        transitionPreparation(preparation, 'starting');
        try {
          if (
            abort.signal.aborted || cores.get(key) !== entry ||
            (![...sessions.values()].some((session) => actorKey(session.actor) === key) &&
              !(allowBackground && (await authorizedBackground(actor))))
          ) {
            throw new Error('Employee session closed');
          }
          return await opts.startCore(actor);
        } finally {
          releaseStart();
        }
      })().then(async (core) => {
        try {
          enterpriseCoreHost(core);
          enterpriseProxyHost(core);
          if (entry) {
            entry.ready = true;
            // Capacity wait is not worker idle time. Start the idle budget when usable.
            entry.lastUsed = Date.now();
            transitionPreparation(preparation, 'ready');
            preparationFailures.delete(key);
            logPreparationOutcome(preparation, 'success', 'READY', Date.now());
          }
          return core;
        } catch (error) {
          await core.stop();
          throw error;
        }
      });
      entry = { actor, started, lastUsed: Date.now(), ready: false, admitted: false, abort, preparation };
      cores.set(key, entry);
      void started
        .then((core) =>
          core.invalidated?.then(async () => {
            // Intentional idle reclamation removes the entry before stopping its worker.
            // Only unexpected invalidation of the CURRENT worker can revoke identity.
            if (cores.get(key)?.started !== started) return;
            const affected = [...sessions].filter(([, session]) => actorKey(session.actor) === key).map(([id]) => id);
            await Promise.all(affected.map(revoke));
            if (cores.get(key)?.started === started) await stopCore(key);
          })
        )
        .catch(() => {});
      started.catch((error) => {
        if (cores.get(key)?.started === started) cores.delete(key);
        if (entry?.admitted) {
          entry.admitted = false;
          occupied -= 1;
          advanceStarts();
        }
        if (!abort.signal.aborted) recordPreparationFailure(key, preparation, error);
      });
    }
    if (activity) entry.lastUsed = Date.now();
    return entry.started;
  };

  const reconcileAuthorization = async (): Promise<void> => {
    await Promise.all([...sessions].map(async ([id, session]) => {
      if (session.expiresAt < Date.now() || !(await validateSession(session))) {
        if (sessions.get(id) === session) await revoke(id);
      }
    }));
    for (const [key, entry] of cores) {
      const backgroundReady = await authorizedBackground(entry.actor);
      const actorSessions = [...sessions].filter(([, session]) => actorKey(session.actor) === key);
      if (actorSessions.length && opts.hasBackgroundJobs?.(entry.actor) && !backgroundReady) {
        // A stored grant that cannot be verified must stop the running Core,
        // even when this employee has a valid interactive session. Keep the
        // RC2 session itself; its next request starts a fresh Core.
        for (const [, session] of actorSessions) closeSessionConnections(session);
        await stopCore(key);
      } else if (actorSessions.length) {
        await opts.reconcileCronJobs?.(entry.actor).catch(() => {});
      } else if (!backgroundReady) {
        await stopCore(key);
      }
    }
  };
  let reaping = false;
  const reap = setInterval(() => {
    if (reaping) return;
    reaping = true;
    void reconcileAuthorization().then(reapIdleCores).catch(() => {}).finally(() => { reaping = false; });
  }, 60_000);
  reap.unref();

  const taskPrepared = new Set<string>();
  const tasks =
    opts.profileRoot && opts.taskRuntime
      ? new TaskRunner({
          root: opts.profileRoot,
          origin: opts.publicOrigin,
          queueLimit: Math.max(1, opts.maxQueuedCoreStarts ?? 2),
          core: async (actor) => {
            const k = actorKey(actor);
            if (!cores.has(k)) taskPrepared.add(k);
            try {
              return await getCore(actor, true, true, 'accepted_task');
            } finally {
              taskPrepared.delete(k);
            }
          },
          cancelPreparation: async (actor) => {
            const k = actorKey(actor);
            if (taskPrepared.has(k) && !cores.get(k)?.ready) await stopCore(k);
          },
          peek: async (actor) => {
            const entry = cores.get(actorKey(actor));
            return entry?.ready ? entry.started : undefined;
          },
          issue: opts.taskRuntime.issueTaskGrant,
    prepare: actor => opts.refreshResources?.(actor) || Promise.resolve(),
          check: opts.taskRuntime.checkTaskGrant,
          revoke: opts.taskRuntime.revokeTaskGrant,
          bind: opts.taskRuntime.bindTask,
          actors: opts.taskRuntime.taskActors,
          trustedConfirmation: opts.taskRuntime.trustedTaskConfirmation,
        })
      : undefined;
  if (tasks) await tasks.recover().catch(() => console.warn('[Enterprise tasks] recovery deferred; employee login remains available'));

  const server = http.createServer(async (req, res) => {
    const requestStarted = performance.now();
    res.setHeader('x-aion-enterprise-web', '1');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method || '');
    if (!validOrigin(req, unsafe)) return reply(res, 403, { error: 'ORIGIN_DENIED' });
    if (!req.url || !req.url.startsWith('/')) return reply(res, 400, { error: 'BAD_REQUEST' });
    if (req.url.startsWith('/api/internal/') || req.url.startsWith('/api/cron/internal/')) {
      return reply(res, 404, { error: 'NOT_FOUND' });
    }
    if (req.url === '/enterprise/login' && req.method === 'GET') {
      const brand = loginBrand(await opts.publicBrand?.().catch((): null => null));
      const english = /\ben(?:-|,|;|$)/i.test(req.headers['accept-language'] || '') &&
        !/^zh\b/i.test(req.headers['accept-language'] || '');
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      });
      res.end(loginPage(brand, english, nonce));
      return;
    }
    if ((req.url === '/enterprise/login' || req.url === '/enterprise/password') && req.method === 'POST') {
      const client = clientMetadata(req, opts.trustedProxyToken);
      if (!client) return reply(res, 401, { error: 'LOGIN_FAILED' });
      if (sessions.size + pendingSessions >= maxSessions) return reply(res, 503, { error: 'SESSION_CAPACITY' });
      const now = Date.now();
      while (loginAttempts.length && loginAttempts[0] < now - 60_000) loginAttempts.shift();
      if (loginAttempts.length >= 300) return reply(res, 429, { error: 'TOO_MANY_ATTEMPTS' });
      loginAttempts.push(now);
      pendingSessions += 1;
      try {
        const input = JSON.parse((await body(req, LOGIN_BODY)).toString('utf8')) as {
          username?: string;
          password?: string;
          newPassword?: string;
        };
        if (typeof input.username !== 'string' || typeof input.password !== 'string') throw new Error('Invalid login');
        if (req.url === '/enterprise/password') {
          if (!opts.changePassword) return reply(res, 404, { error: 'NOT_FOUND' });
          if (typeof input.newPassword !== 'string' || !/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,16}$/.test(input.newPassword)) {
            return reply(res, 400, { error: 'INVALID_NEW_PASSWORD' });
          }
          await opts.changePassword(input.username, input.password, input.newPassword, client);
          return reply(res, 200, { ok: true });
        }
        const login = await opts.login(input.username, input.password, client);
        res.setHeader('server-timing', `login;dur=${(performance.now() - requestStarted).toFixed(1)}`);
        actorKey(login.actor);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { ...login, sockets: new Set(), requests: new Set(), responses: new Set(), expiresAt: Date.now() + SESSION_MS,
        });
        res.setHeader('set-cookie', `${cookieName}=${id}; Path=/; HttpOnly; ${localDev ? '' : 'Secure; '}SameSite=Strict`);
        return reply(res, 200, { ok: true });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'PASSWORD_CHANGE_REQUIRED') {
          return reply(res, 409, { error: 'PASSWORD_CHANGE_REQUIRED' });
        }
        return reply(res, 401, { error: 'LOGIN_FAILED' });
      } finally { pendingSessions -= 1; }
    }
    if (req.url === '/enterprise/desktop-session' && req.method === 'POST' && opts.resume) {
      if (sessions.size + pendingSessions >= maxSessions) return reply(res, 503, { error: 'SESSION_CAPACITY' });
      const borrowedCookie = req.headers['x-aion-rc2-session'];
      if (typeof borrowedCookie !== 'string' || borrowedCookie.length > 2100) {
        return reply(res, 401, { error: 'UNAUTHENTICATED' });
      }
      pendingSessions += 1;
      try {
        const resumed = await opts.resume(borrowedCookie);
        actorKey(resumed.actor);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { ...resumed, sockets: new Set(), requests: new Set(), responses: new Set(),
          expiresAt: Date.now() + SESSION_MS,
        });
        res.setHeader('set-cookie', `${cookieName}=${id}; Path=/; HttpOnly; ${localDev ? '' : 'Secure; '}SameSite=Strict`);
        return reply(res, 200, { ok: true, actor: resumed.actor });
      } catch {
        return reply(res, 401, { error: 'UNAUTHENTICATED' });
      } finally { pendingSessions -= 1; }
    }
    const authStarted = performance.now();
    const auth = await authenticate(req);
    const authDuration = performance.now() - authStarted;
    res.setHeader('server-timing', `auth;dur=${authDuration.toFixed(1)}`);
    if (!auth) {
      // API consumers need a 401, never a followed redirect containing login HTML.
      // Public enterprise login/password/bootstrap routes have already returned.
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/enterprise/')) {
        res.writeHead(302, { location: '/enterprise/login', 'cache-control': 'no-store' });
        res.end();
        return;
      }
      return reply(res, 401, { error: 'UNAUTHENTICATED' });
    }
    if (/^\/enterprise\/ready(?:\?retry=1)?$/.test(req.url) && req.method === 'GET') {
      const key = actorKey(auth.session.actor);
      if (req.url.endsWith('?retry=1') && preparationFailures.has(key)) {
        preparationFailures.delete(key);preparationAttempts.delete(key);
      }
      const failure = preparationFailures.get(key);
      if (failure) {
        const status = failure.error === 'AUTHENTICATION_REQUIRED' ? 401
          : failure.error === 'CAPABILITY_FORBIDDEN' ? 403 : 503;
        return reply(res, status, { ready: false, phase: 'failed', error: failure.error,
          traceId: failure.attempt.traceId,
          timings: { totalMs: failure.failedAt - failure.attempt.startedAt,
            phaseMs: failure.failedAt - failure.attempt.phaseStartedAt,
          },
          trace: [...failure.attempt.trace,
            { phase: failure.error, atMs: failure.failedAt - failure.attempt.startedAt },
          ],
        });
      }
      const attempt = preparationFor(key);
      const current = cores.get(key);
      if (current?.ready) return reply(res, 200,
        { ready: true, ...preparationPayload(current.preparation) });
      // The actor-scoped Core entry coalesces refreshes, retries and multiple tabs.
      void getCore(auth.session.actor, false, false, 'interactive_prepare').catch((error) => recordPreparationFailure(key, attempt, error));
      res.setHeader('retry-after', '1');
      return reply(res, 202,
        { ready: false, ...preparationPayload(cores.get(key)?.preparation || attempt) });
    }
    if (req.url === '/enterprise/brand' && req.method === 'GET') {
      try {
        const raw = await auth.session.brand?.();
        if (!raw || typeof raw !== 'object') return reply(res, 200, null);
        const value = raw as Record<string, unknown>;
        const productName = typeof value.productName === 'string' ? value.productName.trim().slice(0, 80) : '';
        if (!productName) return reply(res, 200, null);
        const primaryColor = typeof value.primaryColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.primaryColor)
          ? value.primaryColor : '';
        const logoDataUrl = typeof value.logoDataUrl === 'string' &&
          /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.logoDataUrl) &&
          value.logoDataUrl.length <= 2_800_000 ? value.logoDataUrl : '';
        return reply(res, 200, { productName, primaryColor, logoDataUrl, adminUrl: opts.adminUrl || null });
      } catch {
        return reply(res, 502, { error: 'BRAND_UNAVAILABLE' });
      }
    }
    if ((req.url === '/enterprise/logout' || req.url === '/logout') && req.method === 'POST') {
      res.setHeader('set-cookie', `${cookieName}=; Path=/; HttpOnly; ${localDev ? '' : 'Secure; '}SameSite=Strict; Max-Age=0`);
      const backgroundTasksVerified = await revoke(auth.id);
      return reply(res, 200, { ok: true, backgroundTasksVerified });
    }
    auth.session.responses.add(res);
    res.once('close', () => auth.session.responses.delete(res));
    if (req.url === '/enterprise/resources/status' && req.method === 'GET') {
      try {
        return reply(res, 200, opts.resourceStatus?.(auth.session.actor) || { state: 'ready' });
      } catch (error) { return replyCoreFailure(res, error); }
    }
    const taskRoute =
      /^\/enterprise\/tasks(?:\/([A-Za-z0-9_-]{1,100})(?:\/(events|cancel|continue|retry|approve|decline))?)?$/.exec(
        req.url.split('?')[0]
      );
    const taskMessage = /^\/api\/conversations\/([A-Za-z0-9_-]{1,100})\/messages$/.exec(req.url);
    if ((taskRoute || (taskMessage && req.method === 'POST')) && tasks) {
      try {
        if (taskMessage) {
          const input = JSON.parse((await body(req, 128000)).toString()) as Record<string, unknown>;
          const result = await tasks.accept(auth.session.actor, taskMessage[1], input);
          return reply(res, 202, { success: true, data: result.receipt });
        }
        const id = taskRoute![1],
          action = taskRoute![2];
        if (req.method === 'GET' && !id) return reply(res, 200, await tasks.list(auth.session.actor));
        if (req.method === 'GET' && id && action === 'events') {
          await tasks.detail(auth.session.actor, id);
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            'x-accel-buffering': 'no',
          });
          let busy = false;
          const timer = setInterval(() => {
            if (busy) return;
            busy = true;
            void (async () => {
              if (sessions.get(auth.id) !== auth.session || !(await validateSession(auth.session))) {
                res.end();
                return;
              }
              res.write('data: ' + JSON.stringify(await tasks.detail(auth.session.actor, id)) + '\n\n');
            })()
              .catch(() => res.end())
              .finally(() => {
                busy = false;
              });
          }, 3000);
          const limit = setTimeout(() => res.end(), 300000);
          timer.unref();
          limit.unref();
          res.once('close', () => {
            clearInterval(timer);
            clearTimeout(limit);
          });
          return;
        }
        if (req.method === 'GET' && id && !action) return reply(res, 200, await tasks.detail(auth.session.actor, id));
        if (req.method === 'POST' && id && action && action !== 'events') {
          const input = JSON.parse((await body(req, 128000)).toString()) as Record<string, unknown>;
          return reply(res, 200, await tasks.action(auth.session.actor, id, action, input));
        }
        return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      } catch (error) {
        if (error instanceof TaskError) return reply(res, error.status, { error: error.message });
        return reply(res, 503, { error: 'TASK_SERVICE_UNAVAILABLE' });
      }
    }
    if (req.url === '/enterprise/resources/refresh' && req.method === 'POST') {
      if (!opts.refreshResources) return reply(res, 503, { error: 'RESOURCE_REFRESH_UNAVAILABLE' });
      try {
        if (!cores.get(actorKey(auth.session.actor))?.ready)
          return reply(res, 200, { ok: true, state: 'ready', applyOnNextStart: true });
        const status = (await opts.refreshResources(auth.session.actor)) || { state: 'ready' };
        return reply(res, status.state === 'pending' ? 202 : 200, { ok: true, ...status });
      } catch (error) { return replyCoreFailure(res, error); }
    }
    const scopeRoute = /^\/enterprise\/knowledge-scope\/([A-Za-z0-9_-]{1,100})$/.exec(req.url);
    const checkKnowledge = async (scope: KnowledgeScope): Promise<void> => {
      if (!opts.controlRequest) throw new Error('KNOWLEDGE_UNAVAILABLE');
      for (const id of new Set([...scope.baseIds, ...scope.documents.map((d) => d.baseId)])) {
        const response = await opts.controlRequest(auth.session.actor, `/ai/resources/${id}?active=true`, { method: 'GET',
        });
        const value = (await response.json()) as { code?: number; data?: { resourceType?: string; actions?: string[] };
        };
        if (!response.ok || value.code !== 200 || value.data?.resourceType !== 'KNOWLEDGE' || !value.data.actions?.includes('USE')) throw new Error('KNOWLEDGE_SCOPE_REVOKED');
      }
      for (const doc of scope.documents) {
        const response = await opts.controlRequest(auth.session.actor, `/ai/knowledge/documents/${doc.documentId}/versions/${doc.version}`, { method: 'GET' });
        const value = (await response.json()) as { code?: number; data?: { baseId?: string; status?: string } };
        if (!response.ok || value.code !== 200 || value.data?.baseId !== doc.baseId || value.data.status !== 'READY') throw new Error('KNOWLEDGE_SCOPE_REVOKED');
      }
    };
    if (scopeRoute && opts.profileRoot) {
      try {
        const owned = (await readProfile(opts.profileRoot, auth.session.actor, 'conversation', scopeRoute[1])) as { exists?: boolean;
        };
        if (!owned.exists) return reply(res, 404, { error: 'CONVERSATION_NOT_FOUND' });
        const store = await OfficeStore.create(opts.profileRoot, auth.session.actor);
        if (req.method === 'GET') return reply(res, 200, { scope: (await store.knowledgeScope(scopeRoute[1])) || null });
        if (req.method !== 'PUT') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        const scope = validateKnowledgeScope(JSON.parse((await body(req, 8000)).toString('utf8')));
        await checkKnowledge(scope);
        await store.selectKnowledge(scopeRoute[1], scope);
        return reply(res, 200, { scope });
      } catch (error) {
        const code = (error as Error).message;
        const known = ['KNOWLEDGE_SCOPE_REVOKED', 'INVALID_KNOWLEDGE_SCOPE', 'INVALID_CONVERSATION', 'KNOWLEDGE_SCOPE_LIMIT',
        ].includes(code);
        return reply(res, code === 'KNOWLEDGE_SCOPE_REVOKED' ? 403 : known ? 400 : 503, { error: known ? code : 'KNOWLEDGE_SCOPE_UNAVAILABLE',
        });
      }
    }
    if (req.url.startsWith('/enterprise/control/')) {
      const route = req.url.slice('/enterprise/control'.length);
      // No arbitrary proxy, auth reset, internal service routes or admin wildcard.
      if (!/^\/ai\/(?:resources|knowledge|citations|files|share-targets|mcp|models|brand|me|usage)(?:[/?]|$)/.test(route) ||
          /(?:\.\.|%2e|%2f|%5c)/i.test(route.split('?')[0]) || !opts.controlRequest) return reply(res, 404, { error: 'CONTROL_ROUTE_UNAVAILABLE' });
      const abort = new AbortController();res.once('close', () => abort.abort());
      try {
        const raw = ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : await body(req, MAX_BODY);
        const upstream = await opts.controlRequest(auth.session.actor, route, { method: req.method,
          headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
          ...(raw ? { body: raw as unknown as BodyInit } : {}), signal: abort.signal,
        });
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (bytes.length > MAX_BODY) return reply(res, 502, { error: 'CONTROL_RESPONSE_TOO_LARGE' });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          ...(upstream.headers.get('content-disposition') ? { 'content-disposition': upstream.headers.get('content-disposition')! } : {}),
        });
        res.end(bytes);
      } catch { if (!res.destroyed) reply(res, 502, { error: 'CONTROL_UNAVAILABLE' }); }
      return;
    }
    if (req.url.startsWith('/enterprise/memories') || req.url.startsWith('/enterprise/files')) {
      if (!opts.profileRoot) return reply(res, 503, { error: 'OFFICE_STORAGE_UNAVAILABLE' });
      const url = new URL(req.url, origin);
      try {
        const store = await OfficeStore.create(opts.profileRoot, auth.session.actor);
        if (url.pathname === '/enterprise/memories') {
          if (req.method === 'GET') return reply(res, 200, { items: await store.memories() });
          if (req.method === 'PUT') return reply(res, 200, await store.remember(JSON.parse((await body(req, 16000)).toString())));
          if (req.method === 'DELETE') { await store.forget(url.searchParams.get('id') || '');return reply(res, 200, { ok: true }); }
          return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
        }
        const { workDir: workspaceRoot } = await prepareEnterpriseProfile(opts.profileRoot, auth.session.actor);
        if (!workspaceRoot) return reply(res, 503, { error: 'WORKSPACE_UNAVAILABLE' });
        if (url.pathname === '/enterprise/files' && req.method === 'GET')
          return reply(res, 200, await store.files(workspaceRoot));
        const requested = url.searchParams.get('path') || '';
        const uploadRoot = path.join(
          enterpriseProfilePath(opts.profileRoot, auth.session.actor),
          'runtime-temp',
          'aionui'
        );
        const attachment = path.isAbsolute(requested) && requested.startsWith(uploadRoot + path.sep);
        const inputRoot = attachment ? uploadRoot : workspaceRoot;
        const name = path.isAbsolute(requested) ? path.relative(inputRoot, requested) : requested;
        const version = url.searchParams.get('version') || undefined;
        if (attachment && version) return reply(res, 400, { error: 'ATTACHMENT_HISTORY_UNAVAILABLE' });
        if (url.pathname === '/enterprise/files/preview' && req.method === 'GET') {
          const bytes = await store.downloadOriginal(inputRoot, name, version);
          const hash = createHash('sha256').update(bytes).digest('hex');
          if (url.searchParams.get('knownSha') === hash)
            return reply(res, 200, { unchanged: true, sourceSha256: hash });
          const preview = await previewOfficeFile(name, bytes, {
            ...(url.searchParams.has('sheet') ? { sheet: url.searchParams.get('sheet')! } : {}),
            start: Number(url.searchParams.get('start') || '0'),
          });
          if (!(await validateSession(auth.session))) {
            await revoke(auth.id);
            return reply(res, 401, { error: 'UNAUTHENTICATED' });
          }
          if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
          if (
            createHash('sha256')
              .update(await store.downloadOriginal(inputRoot, name, version))
              .digest('hex') !== hash
          )
            return reply(res, 409, { error: 'FILE_CHANGED_RETRY' });
          return reply(res, 200, preview);
        }
        if (url.pathname === '/enterprise/files/download' && req.method === 'GET') {
          const bytes = await store.downloadOriginal(inputRoot, name, version);
          if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`,
          });
          res.end(bytes);
          return;
        }
        if (url.pathname === '/enterprise/files/diff' && req.method === 'GET')
          return reply(res, 200, await store.diff(workspaceRoot, name, url.searchParams.get('version') || ''));
        if (url.pathname === '/enterprise/files/restore' && req.method === 'POST') {
          const input = JSON.parse((await body(req, 8192)).toString()) as { path: string; version: string };
          await store.restore(workspaceRoot, input.path, input.version);
          return reply(res, 200, { ok: true });
        }
        if (url.pathname === '/enterprise/files/upload' && req.method === 'POST') {
          const raw = await body(req, MAX_BODY + 1024 * 1024);
          const data = await new Response(raw as unknown as BodyInit, { headers: { 'content-type': req.headers['content-type'] || '' },
          }).formData();
          const files = data.getAll('files').filter((item): item is File => typeof item !== 'string');
          const paths = JSON.parse(String(data.get('paths') || '[]')) as string[];
          if (!files.length || files.length > 100 || files.reduce((n, file) => n + file.size, 0) > MAX_BODY || (paths.length && paths.length !== files.length)) return reply(res, 400, { error: 'UPLOAD_LIMIT_100_FILES_50MB' });
          const uploaded: string[] = [], failed: Array<{ path: string; error: string }> = [];
          for (let i = 0; i < files.length; i += 1) {
            const destination = '资料/' + (paths[i] || files[i].name);
            try {
              await store.upload(workspaceRoot, destination, Buffer.from(await files[i].arrayBuffer()));
              uploaded.push(destination);
            } catch (error) { failed.push({ path: destination, error: (error as Error).message }); }
          }
          return reply(res, 200, { uploaded, failed });
        }
        return reply(res, 404, { error: 'NOT_FOUND' });
      } catch (error) {
        if (error instanceof CoreCapacityError) return replyCoreFailure(res, error);
        return reply(res, 400, { error: (error as Error).message.slice(0, 200) });
      }
    }
    if (
      opts.profileRoot &&
      req.method === 'GET' &&
      !cores.get(actorKey(auth.session.actor))?.ready &&
      (clientSettingsRoute(req.url) || req.url === '/api/settings' || req.url.startsWith('/enterprise/conversations'))
    ) {
      const query = new URL(req.url, origin);
      const history = query.pathname === '/enterprise/conversations';
      if (!history && !['/api/settings/client', '/api/settings'].includes(query.pathname))
        return reply(res, 404, { error: 'NOT_FOUND' });
      const cursor = query.searchParams.get('cursor') || '';
      if (history && cursor && !isConversationId(cursor)) return reply(res, 400, { error: 'BAD_REQUEST' });
      try {
        const data = await readProfile(
          opts.profileRoot,
          auth.session.actor,
          history ? 'history' : query.pathname === '/api/settings' ? 'settings' : 'preferences',
          history ? cursor : JSON.stringify((query.searchParams.get('keys') || '').split(',').filter(Boolean))
        );
        if (!(await validateSession(auth.session))) {
            await revoke(auth.id);
            return reply(res, 401, { error: 'UNAUTHENTICATED' });
          }
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        if (history) {
          const page = data as {
            items: Array<{ id: string; name: string; updated_at: number; pinned: number; status: string }>;
            next_cursor: string | null;
          };
          return reply(res, 200, {
            ...page,
            items: page.items.map((item) => ({
              key: `enterprise_web:${auth.session.actor.serverId}:${auth.session.actor.userId}:${item.id}`,
              id: item.id,
              name: item.name,
              source: 'enterprise_web',
              modified_at: item.updated_at,
              pinned: !!item.pinned,
              status: item.status === 'running' ? 'idle' : item.status,
              runtime: { state: 'idle', is_processing: false },
            })),
          });
        }
        return reply(res, 200, scrubClientSettings({ success: true, data }));
      } catch {
        return reply(res, 503, { error: 'PROFILE_READ_UNAVAILABLE' });
      }
    }
    if (req.url === '/api/auth/user' && req.method === 'GET') {
      return reply(res, 200, { success: true,
        user: { id: auth.session.actor.userId, username: auth.session.username || auth.session.actor.userId },
      });
    }
    if (opts.profileRoot && req.url.startsWith('/api/') &&
        passiveWorkerRequest(req.method || 'GET', req.url) &&
        !cores.get(actorKey(auth.session.actor))?.ready) {
      if (req.method === 'POST' && /^\/api\/(word|excel|ppt)-preview\/stop$/.test(req.url.split('?')[0]))
        return reply(res, 200, { success: true });
      return reply(res, 409, { error: 'CORE_NOT_RUNNING' });
    }
    if (req.url.startsWith('/enterprise/conversations') && req.method === 'GET') {
      const query = new URL(req.url, origin);
      if (query.pathname !== '/enterprise/conversations') return reply(res, 404, { error: 'NOT_FOUND' });
      const cursor = query.searchParams.get('cursor');
      if (cursor && !isConversationId(cursor)) return reply(res, 400, { error: 'BAD_REQUEST' });
      try {
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''));
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const route = `/api/conversations?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const upstream = await fetch(`${enterpriseCoreBase(core)}${route}`, {
          headers: { 'x-aion-enterprise-local-token': core.localToken }, signal: AbortSignal.timeout(10_000),
        });
        if (!upstream.ok || Number(upstream.headers.get('content-length') || 0) > MAX_PROVIDER_RESPONSE) {
          return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        }
        const raw = await upstream.text();
        if (raw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const parsed: unknown = JSON.parse(raw);
        const data = (parsed as { data?: { items?: unknown; has_more?: unknown } } | null)?.data;
        if (!Array.isArray(data?.items)) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const pinnedIds = new Set<string>();
        let pinnedCursor: string | null = null;
        for (let page = 0; page < 100; page += 1) {
          const pinnedRoute: string = pinnedCursor
            ? `/api/sidebar/items?scope=pinned&cursor=${encodeURIComponent(pinnedCursor)}&limit=100`
            : '/api/sidebar?limit=1&win=pinned%3A100';
          const pinnedResponse: Response = await fetch(`${enterpriseCoreBase(core)}${pinnedRoute}`, {
            headers: { 'x-aion-enterprise-local-token': core.localToken },
            signal: AbortSignal.timeout(10_000),
          });
          if (!pinnedResponse.ok || Number(pinnedResponse.headers.get('content-length') || 0) > MAX_PROVIDER_RESPONSE) {
            return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
          }
          const pinnedRaw: string = await pinnedResponse.text();
          if (pinnedRaw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
          const pinnedData = (JSON.parse(pinnedRaw) as { data?: unknown }).data as
            | {
            groups?: Array<{ scope?: { type?: string }; items?: unknown[]; has_more?: boolean; next_cursor?: string;
                }>;
            items?: unknown[]; has_more?: boolean; next_cursor?: string;
          } | undefined;
          if (!pinnedData || (!pinnedCursor && !Array.isArray(pinnedData.groups))) {
            return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
          }
          const pinnedGroup: { items?: unknown[]; has_more?: boolean; next_cursor?: string } | undefined =
            pinnedCursor ? pinnedData : pinnedData.groups?.find((group) => group.scope?.type === 'pinned');
          if (!pinnedGroup) {
            if (pinnedCursor) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
            break;
          }
          if (!Array.isArray(pinnedGroup.items)) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
          for (const entry of pinnedGroup.items) {
            const item = entry as { type?: string; conversation?: { id?: unknown } };
            if (item?.type === 'conversation' && isConversationId(item.conversation?.id)) pinnedIds.add(item.conversation.id);
          }
          if (pinnedGroup.has_more !== true) break;
          if (typeof pinnedGroup.next_cursor !== 'string' || pinnedGroup.next_cursor === pinnedCursor || page === 99) {
            return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
          }
          pinnedCursor = pinnedGroup.next_cursor;
        }
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const actor = auth.session.actor;
        const items = data.items.filter((item): item is Record<string, unknown> & { id: string } =>
          !!item && typeof item === 'object' && isConversationId(item.id) &&
          typeof item.name === 'string').map((item) => ({
          key: `enterprise_web:${actor.serverId}:${actor.userId}:${item.id}`,
          id: item.id,
          source: 'enterprise_web',
          name: item.name,
          modified_at: typeof item.modified_at === 'number' ? item.modified_at : null,
          status: typeof item.status === 'string' ? item.status : null,
          ...(item.runtime && typeof item.runtime === 'object' && !Array.isArray(item.runtime) ? {
            runtime: (() => {
              const runtime = item.runtime as Record<string, unknown>;
              return {
                ...(typeof runtime.state === 'string' && ['idle', 'starting', 'running', 'cancelling', 'restarting', 'waiting_confirmation'].includes(runtime.state) ? { state: runtime.state } : {}),
                ...(typeof runtime.is_processing === 'boolean' ? { is_processing: runtime.is_processing } : {}),
                ...(Number.isSafeInteger(runtime.pending_confirmations) && Number(runtime.pending_confirmations) >= 0 ? { pending_confirmations: Number(runtime.pending_confirmations) } : {}),
              };
            })(),
          } : {}),
          pinned: pinnedIds.has(item.id),
        }));
        const lastId = data.items.at(-1)?.id;
        const hasMore = data.has_more === true && isConversationId(lastId);
        return reply(res, 200, { items, next_cursor: hasMore ? lastId : null });
      } catch (error) {
        if (!res.destroyed) return replyCoreFailure(res, error);
        return;
      }
    }
    if (req.url.startsWith('/enterprise/search?') && req.method === 'GET') {
      const query = new URL(req.url, origin);
      const keyword = query.searchParams.get('keyword')?.trim() || '';
      const page = Number(query.searchParams.get('page') || '1');
      if (!keyword || keyword.length > 200 || !Number.isInteger(page) || page < 1 || page > 1000) {
        return reply(res, 400, { error: 'BAD_REQUEST' });
      }
      try {
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''));
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const route = `/api/messages/search?keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=20`;
        const upstream = await fetch(`${enterpriseCoreBase(core)}${route}`, {
          headers: { 'x-aion-enterprise-local-token': core.localToken }, signal: AbortSignal.timeout(10_000),
        });
        if (!upstream.ok || Number(upstream.headers.get('content-length') || 0) > MAX_PROVIDER_RESPONSE) {
          return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        }
        const raw = await upstream.text();
        if (raw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const data = (JSON.parse(raw) as { data?: { items?: unknown; has_more?: unknown } } | null)?.data;
        if (!Array.isArray(data?.items)) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const actor = auth.session.actor;
        const items = data.items.filter((item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && typeof item.message_id === 'string' &&
          typeof item.preview_text === 'string' && typeof item.message_created_at === 'number' &&
          !!item.conversation && typeof item.conversation === 'object' &&
          isConversationId(item.conversation.id) &&
          typeof item.conversation.name === 'string').map((item) => {
          const conversation = item.conversation as { id: string; name: string };
          return { key: `enterprise_web:${actor.serverId}:${actor.userId}:${conversation.id}`,
            source: 'enterprise_web', conversation_id: conversation.id, name: conversation.name.slice(0, 500),
            message_id: item.message_id, message_created_at: item.message_created_at,
            preview_text: (item.preview_text as string).slice(0, 500),
            };
        });
        return reply(res, 200, { items, has_more: data.has_more === true });
      } catch (error) {
        if (!res.destroyed) return replyCoreFailure(res, error);
        return;
      }
    }
    if (req.url === '/api/mcp/test-connection' && req.method === 'POST') {
      // Browser reads omit saved credentials; resolve the unchanged transport
      // only from this authenticated actor's Core, never another profile.
      auth.session.responses.add(res);
      const abort = new AbortController();
      res.once('close', () => { auth.session.responses.delete(res); abort.abort(); });
      try {
        const input = JSON.parse((await body(req, 65536)).toString('utf8')) as Record<string, unknown>;
        const transport = input.transport as Record<string, unknown> | undefined;
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''));
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const base = enterpriseCoreBase(core);
        const headers = { 'content-type': 'application/json', 'x-aion-enterprise-local-token': core.localToken };
        if (transport?.credentials_configured === true && !transport.url && !transport.command) {
          if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id))
            return reply(res, 400, { error: 'MCP_SERVER_REQUIRED' });
          const stored = await fetch(`${base}/api/mcp/servers/${encodeURIComponent(input.id)}`, {
            headers, signal: abort.signal,
          });
          if (!stored.ok) return reply(res, stored.status, { error: 'MCP_SERVER_UNAVAILABLE' });
          const raw = await stored.text();
          if (raw.length > MAX_PROVIDER_RESPONSE) throw new Error('Invalid Core response');
          const server = JSON.parse(raw) as { success?: boolean; data?: Record<string, unknown> };
          if (!server.success || !server.data?.transport) throw new Error('Invalid Core response');
          input.name = server.data.name;
          input.transport = server.data.transport;
        }
        const tested = await fetch(`${base}/api/mcp/test-connection`, {
          method: 'POST', headers, body: JSON.stringify(input), signal: abort.signal,
        });
        const raw = await tested.text();
        if (raw.length > MAX_PROVIDER_RESPONSE) throw new Error('Invalid Core response');
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        reply(res, tested.status, scrubMcpServerSecrets(JSON.parse(raw)));
      } catch (error) {
        if (error instanceof CoreCapacityError && !res.destroyed) return replyCoreFailure(res, error);
        if (!res.destroyed) reply(res, 502, { error: 'MCP_CONNECTION_UNAVAILABLE' });
      }
      return;
    }
    if (clientSettingsRoute(req.url) && req.method === 'PUT') {
      auth.session.responses.add(res);
      const abort = new AbortController();
      res.once('close', () => { auth.session.responses.delete(res); abort.abort(); });
      try {
        const raw = await body(req, 1024 * 1024);
        const updates: unknown = JSON.parse(raw.toString('utf8'));
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
          return reply(res, 400, { error: 'BAD_REQUEST' });
        }
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''));
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const base = `${enterpriseCoreBase(core)}/api/settings/client`;
        const current = await fetch(base, { headers: { 'x-aion-enterprise-local-token': core.localToken },
          signal: abort.signal,
        });
        if (!current.ok || Number(current.headers.get('content-length') || 0) > MAX_PROVIDER_RESPONSE) {
          return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        }
        const currentRaw = await current.text();
        if (currentRaw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const previous = (JSON.parse(currentRaw) as { data?: unknown } | null)?.data;
        const merged = mergeClientSettingsSecrets(updates, previous);
        const saved = await fetch(base, { method: 'PUT', headers: {
          'content-type': 'application/json', 'x-aion-enterprise-local-token': core.localToken,
        }, body: JSON.stringify(merged), signal: abort.signal,
        });
        const savedRaw = await saved.text();
        if (savedRaw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const cleaned = scrubClientSettings(JSON.parse(savedRaw));
        reply(res, saved.status, cleaned);
      } catch (error) {
        if (error instanceof CoreCapacityError && !res.destroyed) return replyCoreFailure(res, error);
        if (!res.destroyed) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
      }
      return;
    }
    if (/^\/api\/fs\/dir(?:\?|$)/.test(req.url)) {
      if (req.method !== 'POST') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      auth.session.responses.add(res);
      const abort = new AbortController();
      res.once('close', () => { auth.session.responses.delete(res); abort.abort(); });
      try {
        const input = JSON.parse((await body(req, 8192)).toString('utf8')) as { dir?: unknown };
        if (typeof input.dir !== 'string' || !path.isAbsolute(input.dir) || input.dir.length > 4096) {
          return reply(res, 400, { error: 'BAD_REQUEST' });
        }
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''));
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        if (!core.workspaceRoot) return reply(res, 503, { error: 'WORKSPACE_UNAVAILABLE' });
        const [root, directory] = await Promise.all([realpath(core.workspaceRoot), realpath(input.dir)]);
        if (!withinDirectory(directory, root)) return reply(res, 403, { error: 'WORKSPACE_DENIED' });
        const upstream = await fetch(`${enterpriseCoreBase(core)}/api/fs/dir`, { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-aion-enterprise-local-token': core.localToken },
          body: JSON.stringify({ dir: input.dir, root: core.workspaceRoot }), signal: abort.signal,
        });
        if (!upstream.ok || Number(upstream.headers.get('content-length') || 0) > MAX_PROVIDER_RESPONSE) {
          return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        }
        const raw = await upstream.text();
        if (raw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const parsed = JSON.parse(raw) as { success?: unknown; data?: unknown };
        if (parsed.success !== true) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const entries = await scopedDirectoryEntries(parsed.data, root);
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        return reply(res, 200, { success: true, data: entries });
      } catch (error) {
        if (error instanceof CoreCapacityError && !res.destroyed) return replyCoreFailure(res, error);
        if (!res.destroyed) return reply(res, 400, { error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
    }
    const cronCollection = req.url === '/api/cron/jobs' && req.method === 'POST';
    const cronItem = /^\/api\/cron\/jobs\/(cron_[A-Za-z0-9_-]{8,80})$/.exec(req.url);
    if (opts.syncCronGrant && (cronCollection || (cronItem && ['PUT', 'DELETE'].includes(req.method || '')))) {
      auth.session.responses.add(res);
      res.once('close', () => auth.session.responses.delete(res));
      try {
        const requestBody = req.method === 'DELETE' ? undefined : await body(req, 1024 * 1024);
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''));
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const base = enterpriseCoreBase(core);
        const headers = { 'x-aion-enterprise-local-token': core.localToken, 'content-type': 'application/json' };
        const upstream = await fetch(`${base}${req.url}`, { method: req.method, headers,
          body: requestBody?.toString('utf8'), signal: AbortSignal.timeout(20_000),
        });
        const raw = await upstream.text();
        if (raw.length > MAX_PROVIDER_RESPONSE) return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
        const parsed = JSON.parse(raw) as { success?: boolean; data?: { id?: string; enabled?: boolean } };
        if (upstream.ok && parsed.success === true) {
          const jobId = cronItem?.[1] || parsed.data?.id;
          if (!jobId || !/^cron_[A-Za-z0-9_-]{8,80}$/.test(jobId))
            return reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
          const enabled = req.method !== 'DELETE' && parsed.data?.enabled === true;
          try { await opts.syncCronGrant(auth.session.actor, jobId, enabled); }
          catch {
            if (enabled) {
              await fetch(`${base}/api/cron/jobs/${jobId}`, { method: cronCollection ? 'DELETE' : 'PUT',
                headers, body: cronCollection ? undefined : JSON.stringify({ enabled: false }),
                signal: AbortSignal.timeout(5000),
              }).catch(() => {});
            }
            return reply(res, 503, { error: 'BACKGROUND_AUTHORIZATION_UNAVAILABLE' });
          }
        }
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        });
        res.end(raw);
      } catch (error) {
        if (error instanceof CoreCapacityError && !res.destroyed) return replyCoreFailure(res, error);
        if (!res.destroyed) reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
      }
      return;
    }
    const taskCancel = /^\/api\/conversations\/([A-Za-z0-9_-]{1,100})\/cancel$/.exec(req.url);
    if (tasks && taskCancel && req.method === 'POST') {
      try {
        const task = (await tasks.detail(auth.session.actor, taskCancel[1])) as {
          attempts: Array<{ id: string; turnId?: string }>;
        };
        const input = JSON.parse((await body(req, 128000)).toString()) as { turn_id?: string };
        const attempt = task.attempts.at(-1)!;
        if (input.turn_id !== attempt.id && input.turn_id !== attempt.turnId)
          return reply(res, 409, { error: 'TASK_ATTEMPT_CHANGED' });
        await tasks.action(auth.session.actor, taskCancel[1], 'cancel', { attemptId: attempt.id });
        const updated = await tasks.detail(auth.session.actor,taskCancel[1]) as {attempts:Array<{state:string}>};
        const stoppingTask = updated.attempts.at(-1)?.state === 'cancelling';
        return reply(res, 200, {
          success: true,
          data: {
            runtime: {
              state: stoppingTask ? 'cancelling' : 'idle',
              turn_id: attempt.turnId || attempt.id,
              is_processing: stoppingTask,
              pending_confirmations: 0,
              can_send_message: !stoppingTask,
            },
          },
        });
      } catch (error) {
        if (!(error instanceof TaskError && error.status === 404))
          return reply(res, error instanceof TaskError ? error.status : 503, {
            error: error instanceof TaskError ? error.message : 'TASK_SERVICE_UNAVAILABLE',
          });
      }
    }
    if (
      opts.profileRoot &&
      req.method === 'POST' &&
      /^\/api\/(conversations|teams)\/[^/]+\/active-lease$/.test(req.url)
    ) {
      return reply(res, 200, { success: true });
    }
    if (req.url.startsWith('/api/') || req.url.startsWith('/api?')) {
      if (Number(req.headers['content-length'] || 0) > MAX_BODY) return reply(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      auth.session.responses.add(res);
      res.once('close', () => auth.session.responses.delete(res));
      try {
        if (opts.profileRoot && req.method === 'GET' && !cores.has(actorKey(auth.session.actor)))
          return reply(res, 409, { error: 'CORE_NOT_RUNNING' });
        const messageRoute = /^\/api\/conversations\/([A-Za-z0-9_-]{1,100})\/messages$/.exec(req.url);
        if (opts.profileRoot && req.method === 'POST' && messageRoute) {
          const store = await OfficeStore.create(opts.profileRoot, auth.session.actor);
          const scope = await store.knowledgeScope(messageRoute[1]);
          if (scope) {
            try { await checkKnowledge(scope); }
            catch { return reply(res, 403, { error: 'KNOWLEDGE_SCOPE_REVOKED' }); }
          }
        }
        const core = await getCore(auth.session.actor, false, !passiveWorkerRequest(req.method || 'GET', req.url || ''),
          req.method === 'POST' && /^\/api\/conversations(?:\/[^/]+\/messages)?$/.test(req.url) ? 'task_request' : 'user_operation');
        if (sessions.get(auth.id) !== auth.session || res.destroyed) return;
        const upstream = http.request(
          {
            hostname: enterpriseCoreHost(core),
            port: core.port,
            method: req.method,
            path: req.url,
            headers: proxyHeaders(req, core),
          },
          (upstreamRes) => {
            const headers: http.IncomingHttpHeaders = {
              ...upstreamRes.headers,
              'cache-control': 'no-store',
              'x-zhenwork-core-ready': '1',
            };
            delete headers['set-cookie'];
            const scrubProviders = providerRoute(req.url || '');
            const scrubMcpServers = mcpServerRoute(req.url || '');
            const scrubPreferences = clientSettingsRoute(req.url || '');
            if (scrubProviders || scrubMcpServers || scrubPreferences) {
              if (!upstreamRes.headers['content-type']?.includes('application/json')) {
                upstreamRes.resume();
                reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
                return;
              }
              const chunks: Buffer[] = [];
              let size = 0;
              upstreamRes.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_PROVIDER_RESPONSE) upstreamRes.destroy();
                else chunks.push(chunk);
              });
              upstreamRes.once('end', () => {
                if (res.destroyed) return;
                try {
                  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                  const cleaned = JSON.stringify(scrubProviders ? scrubProviderSecrets(parsed) :
                    scrubMcpServers ? scrubMcpServerSecrets(parsed) : scrubClientSettings(parsed));
                  delete headers['content-length'];
                  delete headers['content-encoding'];
                  delete headers['transfer-encoding'];
                  res.writeHead(upstreamRes.statusCode || 502, headers);
                  res.end(cleaned);
                } catch {
                  reply(res, 502, { error: 'CORE_RESPONSE_INVALID' });
                }
              });
              upstreamRes.once('error', () => { if (!res.destroyed) reply(res, 502, { error: 'CORE_RESPONSE_INVALID' }); });
              return;
            }
            res.writeHead(upstreamRes.statusCode || 502, headers);
            upstreamRes.pipe(res);
          }
        );
        auth.session.requests.add(upstream);
        const clearRequest = () => auth.session.requests.delete(upstream);
        upstream.once('close', clearRequest);
        res.once('close', () => {
          clearRequest();
          auth.session.responses.delete(res);
          if (!upstream.destroyed) upstream.destroy();
        });
        upstream.on('error', () => {
          if (!res.headersSent) reply(res, 502, { error: 'CORE_UNAVAILABLE' });
          else res.destroy();
        });
        let received = 0;
        req.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_BODY) {
            req.destroy();
            upstream.destroy();
          }
        });
        req.pipe(upstream);
      } catch (error) {
        if (!res.destroyed) return replyCoreFailure(res, error);
      }
      return;
    }
    if (req.url === '/login' || req.url === '/logout') return reply(res, 404, { error: 'NOT_FOUND' });
    if (req.url === '/sw.js') return reply(res, 404, { error: 'OFFLINE_MODE_DISABLED' });
    if (
      req.method === 'GET' && (req.url === '/' || req.url === '/index.html' ||
        req.headers.accept?.includes('text/html'))
    ) {
      if (
        !opts.profileRoot &&
        (!cores.get(actorKey(auth.session.actor))?.ready || stopping.has(actorKey(auth.session.actor)))
      ) {
        const nonce = randomBytes(16).toString('base64');
        const brand = loginBrand(await auth.session.brand?.().catch((): null => null));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
        });
        res.end(enterpriseReadinessPage(req.headers['accept-language'] || '', nonce, brand));return;
      }
      const html = await readFile(path.join(opts.staticDir, 'index.html'), 'utf8');
      const nonce = randomBytes(16).toString('base64');
      const brand = loginBrand(await auth.session.brand?.().catch((): null => null));
      const bootstrap = enterpriseBootstrapShell(req.headers['accept-language'] || '', nonce, brand);
      const content = html.replace(/<title>[\s\S]*?<\/title>/i, '')
        .replace('</head>', `${bootstrap.head}<script>window.__AION_ENTERPRISE_WEB__=true;</script></head>`)
        .replace(/(<div\s+id=["']root["'][^>]*>)[\s\S]*?(<\/div>)/i,
          (_match, open: string, close: string) => `${open}${bootstrap.body}${close}`)
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': [
          "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "script-src-attr 'none'",
          "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
          "font-src 'self' data:", `connect-src 'self' ${localDev ? 'ws' : 'wss'}://${origin.host}`,
          "frame-src 'self' blob:", "worker-src 'self' blob:", "object-src 'none'",
          "base-uri 'self'", "form-action 'self'",
        ].join('; '),
      });
      res.end(content);
      return;
    }
    if (await serveReleaseAsset(req, res, opts.staticDir)) return;
    res.setHeader('cache-control', 'no-store');
    await serveHandler(req, res, { public: opts.staticDir, rewrites: [{ source: '**', destination: '/index.html' }] });
  });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      if (!req.url || !/^\/(?:ws|api\/stt\/stream)(?:\?|$)/.test(req.url) || !validOrigin(req, true)) {
        socket.destroy();
        return;
      }
      const auth = await authenticate(req);
      if (!auth) {
        socket.destroy();
        return;
      }
      if (!cores.has(actorKey(auth.session.actor))) {
        const key = req.headers['sec-websocket-key'];
        if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
        const accept = createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        // The close frame follows the successful upgrade, preserving the browser's idle protocol.
        socket.end(IDLE_CORE_WS_CLOSE);
        return;
      }
      const core = await getCore(auth.session.actor, false, false);
      if (sessions.get(auth.id) !== auth.session) {
        socket.destroy();
        return;
      }
      const upstream = net.connect(core.port, enterpriseCoreHost(core));
      auth.session.sockets.add(socket);
      const monitor = setInterval(() => {
        void authenticate(req).then((active) => {
          if (!active || active.id !== auth.id) socket.destroy();
        });
      }, 5000);
      monitor.unref();
      const close = () => {
        clearInterval(monitor);
        auth.session.sockets.delete(socket);
        socket.destroy();
        upstream.destroy();
      };
      socket.once('error', close);
      socket.once('close', close);
      upstream.once('error', close);
      upstream.once('close', close);
      upstream.once('connect', () => {
        const headers = proxyHeaders(req, core);
        const lines = [`GET ${req.url} HTTP/1.1`];
        for (const [name, value] of Object.entries(headers)) {
          if (Array.isArray(value)) for (const part of value) lines.push(`${name}: ${part}`);
          else if (value !== undefined) lines.push(`${name}: ${value}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    })().catch(() => socket.destroy());
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(reap);
    throw error;
  }
  return {
    port: (server.address() as { port: number }).port,
    reconcileAuthorization,
    reapIdleCores,
    capacity: () => ({
      sessions: sessions.size,
      pendingSessions,
      cores: occupied,
      starting,
      queuedStarts: queuedStarts.length,
    }),
    startBackgroundCore: async (actor) => {
      if (!(await authorizedBackground(actor))) throw new Error('Background Core authorization unavailable');
      if (opts.backgroundDue && !(await opts.backgroundDue(actor))) return;
      await getCore(actor, true, true, 'background_due');
    },
    stop: async () => {
      shuttingDown = true;
      for (const waiter of queuedStarts.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(new Error('Enterprise gateway is stopping'));
      }
      await tasks?.stop();
      clearInterval(reap);
      const sessionResults = await Promise.all([...sessions.keys()].map(revoke));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const coreResults = await Promise.allSettled([...cores.values()].map(async (entry) => (await entry.started).stop()));
      const stoppingResults = await Promise.allSettled(stopping.values());
      if (sessionResults.includes(false) || [...coreResults, ...stoppingResults].some((result) =>
        result.status === 'rejected')) throw new Error('Enterprise Core shutdown incomplete');
    },
  };
}
