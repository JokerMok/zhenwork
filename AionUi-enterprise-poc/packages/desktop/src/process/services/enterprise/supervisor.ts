import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createReadStream } from 'node:original-fs';
import { createHash, randomUUID } from 'node:crypto';
import { Rc2Client, assertLoadedResourceVersion } from './rc2Client.mjs';
import { prepareProfile } from './profile.mjs';
import { EnterpriseLifecycle } from './lifecycle.mjs';
import { EnterpriseModelProxy } from './modelProxy.mjs';
import { EnterpriseMcpProxy } from './mcpProxy.mjs';
import { loadEnterpriseUpdateConfig, parseEnterpriseReleaseManifest } from './updateConfig.mjs';
import { loadEnterpriseWebConfig } from './webConfig.mjs';
import { autoUpdaterService } from '../autoUpdaterService';
import {
  forgetRememberedAccount,
  listRememberedAccountNames,
  normalizeServer,
  readPilotResourcePointers,
  readRememberedPassword,
  readServerConfig,
  saveRememberedAccount,
  saveServerConfig,
} from './serverConfig.mjs';
import { normalizeLanguageCode } from '@/common/config/i18n';
import enUSLogin from '@renderer/services/i18n/locales/en-US/login.json';
import zhCNLogin from '@renderer/services/i18n/locales/zh-CN/login.json';
import jaJPLogin from '@renderer/services/i18n/locales/ja-JP/login.json';
import zhTWLogin from '@renderer/services/i18n/locales/zh-TW/login.json';
import koKRLogin from '@renderer/services/i18n/locales/ko-KR/login.json';
import trTRLogin from '@renderer/services/i18n/locales/tr-TR/login.json';
import ruRULogin from '@renderer/services/i18n/locales/ru-RU/login.json';
import ukUALogin from '@renderer/services/i18n/locales/uk-UA/login.json';
import ptBRLogin from '@renderer/services/i18n/locales/pt-BR/login.json';
import deDELogin from '@renderer/services/i18n/locales/de-DE/login.json';
import esESLogin from '@renderer/services/i18n/locales/es-ES/login.json';
import frFRLogin from '@renderer/services/i18n/locales/fr-FR/login.json';
import faIRLogin from '@renderer/services/i18n/locales/fa-IR/login.json';

const defaultProfileRoot = path.join(os.homedir(), '.aionui-enterprise');
const requestedProfileRoot = process.env.AION_ENTERPRISE_PROFILE_ROOT;
const isolatedE2E = process.env.AIONUI_E2E_TEST === '1';
if (isolatedE2E &&
    (!requestedProfileRoot || !path.isAbsolute(requestedProfileRoot) ||
      path.resolve(requestedProfileRoot) === defaultProfileRoot)) {
  throw new Error('Enterprise E2E requires an isolated absolute profile root');
}
const profileRoot = requestedProfileRoot || defaultProfileRoot;
app.setName('AionUi Enterprise Pilot');
mkdirSync(path.join(profileRoot, 'supervisor'), { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(profileRoot, 'supervisor'));
let server = normalizeServer(
  process.env.AION_ENTERPRISE_BASE_URL || 'http://127.0.0.1:3580',
  process.env.AION_ENTERPRISE_ORIGIN
);
let client = new Rc2Client(server.baseUrl, server.origin);
let pilotPointers: Record<string, string> = {};
// The supervisor must not initialize process storage before an employee profile exists.
type LoginLabels = {
  enterpriseAccountLabel: string;
  enterpriseServerUrl: string;
  enterpriseOrigin: string;
  enterpriseRememberPassword: string;
  enterpriseSavedAccount: string;
  enterpriseForgetAccount: string;
  enterpriseSecureStorageUnavailable: string;
  enterpriseSavedPasswordHint: string;
  enterpriseErrors: Record<
    'address' | 'certificate' | 'connection' | 'credentials' | 'origin' | 'version' | 'unknown',
    string
  >;
};
const loginLocales: Record<string, LoginLabels> = {
  'en-US': enUSLogin,
  'zh-CN': zhCNLogin,
  'ja-JP': jaJPLogin,
  'zh-TW': zhTWLogin,
  'ko-KR': koKRLogin,
  'tr-TR': trTRLogin,
  'ru-RU': ruRULogin,
  'uk-UA': ukUALogin,
  'pt-BR': ptBRLogin,
  'de-DE': deDELogin,
  'es-ES': esESLogin,
  'fr-FR': frFRLogin,
  'fa-IR': faIRLogin,
};
// A packaged UI probe may run beside the installed pilot only with its own data root.
// Keep the normal single-instance guard for every employee launch.
const ownsInstance = isolatedE2E ? true : app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
let loginWindow: BrowserWindow | null = null;
let transition: Promise<void> | null = null;
let quitting = false;
let sessionGeneration = 0;
let modelProxy: EnterpriseModelProxy | null = null;
let mcpProxy: EnterpriseMcpProxy | null = null;
let skillStage: string | null = null;
let assistantsStage: string | null = null;
let activeAssistantVersions: Array<{ id: string; version: number }> = [];
let activeSkillId: string | null = null;
let activeSkillVersion: number | null = null;
let activeMcpIds: { resourceId: string; connectionId: string; version: number } | null = null;
let activeModelId: string | null = null;
let downloadRoot: string | null = null;
let updateServerId: string | null = null;
let updateFeedUrl: string | null = null;
let updateChannel: string | null = null;
let verifiedUpdateVersion: string | null = null;
let workerCorePort: number | null = null;
let workerCoreToken: string | null = null;
let webSessionCookie: string | null = null;
let webWindow: BrowserWindow | null = null;
let webOrigin: string | null = null;
const selectedDocuments = new Map<string, { version: number; baseId: string }>();
const lifecycle = new EnterpriseLifecycle({
  executable: process.execPath,
  appEntry: app.isPackaged ? null : app.getAppPath(),
  onCoreReady: (port: number) => { workerCorePort = port; },
  onExit: (reason: string) => {
    if (reason === 'exit') void endSession();
  },
  onRequest: async (action: string, args: unknown, child: unknown) => {
    if (transition || lifecycle.worker !== child) throw new Error('Session closed');
    await client.me();
    if (action === 'web-conversations') {
      const cursor = (args as { cursor?: unknown } | null)?.cursor;
      if (cursor !== undefined && !isWebConversationId(cursor)) {
        throw new Error('Invalid web conversation cursor');
      }
      return fetchWebConversations(cursor as string | undefined);
    }
    if (action === 'web-search') {
      const query = args as { keyword?: unknown; page?: unknown } | null;
      const keyword = typeof query?.keyword === 'string' ? query.keyword.trim() : '';
      const page = query?.page;
      if (!keyword || keyword.length > 200 || !Number.isInteger(page) || (page as number) < 1 || (page as number) > 1000) {
        throw new Error('Invalid web search');
      }
      return fetchWebSearch(keyword, page as number);
    }
    if (action === 'web-open') {
      const id = (args as { id?: unknown } | null)?.id;
      if (!isWebConversationId(id)) throw new Error('Invalid web conversation');
      let cursor: string | null = null;
      let found = false;
      for (let page = 0; page < 100; page += 1) {
        const result = await fetchWebConversations(cursor || undefined);
        if (result.items.some((item) => item.id === id)) { found = true; break; }
        if (!result.next_cursor || result.next_cursor === cursor) break;
        cursor = result.next_cursor;
      }
      if (!found) throw new Error('Web conversation unavailable');
      const cookie = await ensureWebSession();
      if (transition || lifecycle.worker !== child) throw new Error('Session closed');
      await openWebConversation(id, cookie);
      return { opened: true };
    }
    if (action === 'web-open-archive') {
      const cookie = await ensureWebSession();
      if (transition || lifecycle.worker !== child) throw new Error('Session closed');
      await openWebPage('/settings/archived', cookie);
      return { opened: true };
    }
    if (['web-rename', 'web-pin', 'web-archive', 'web-delete'].includes(action)) {
      const request = args as { id?: unknown; name?: unknown; pinned?: unknown } | null;
      if (!isWebConversationId(request?.id)) throw new Error('Invalid web conversation');
      if (action === 'web-rename' && (typeof request?.name !== 'string' ||
          !request.name.trim() || request.name.trim().length > 200)) throw new Error('Invalid web conversation name');
      if (action === 'web-pin' && typeof request?.pinned !== 'boolean') throw new Error('Invalid web pin state');
      if (transition || lifecycle.worker !== child) throw new Error('Session closed');
      return mutateWebConversation(action as 'web-rename' | 'web-pin' | 'web-archive' | 'web-delete',
        request.id, request);
    }
    if (action.startsWith('update-')) {
      if (!updateServerId || updateServerId !== client.serverId || !autoUpdaterService.isInitialized) {
        throw new Error('Enterprise updates are not configured');
      }
      if (action === 'update-state') return { configured: true };
      if (action === 'update-check') {
        const result = await autoUpdaterService.checkForUpdates();
        if (result.updateInfo) {
          await verifyEnterpriseRelease(result.updateInfo.version);
          verifiedUpdateVersion = result.updateInfo.version;
        } else {
          verifiedUpdateVersion = null;
        }
        return {
          success: result.success,
          data: result.updateInfo ? { updateInfo: {
            version: result.updateInfo.version,
            releaseDate: result.updateInfo.releaseDate,
            releaseNotes: typeof result.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined,
          } } : undefined,
          msg: result.error,
        };
      }
      if (action === 'update-download') {
        if (!verifiedUpdateVersion) throw new Error('Check the enterprise release before download');
        await verifyEnterpriseRelease(verifiedUpdateVersion);
        const result = await autoUpdaterService.downloadUpdate();
        return { success: result.success, msg: result.error };
      }
      if (action === 'update-restore') {
        const result = await autoUpdaterService.restoreDownloadedUpdateIfAvailable();
        if (result.data.ready && result.data.version) {
          await verifyEnterpriseRelease(result.data.version);
          verifiedUpdateVersion = result.data.version;
        }
        return { success: result.success, data: result.data, msg: result.error };
      }
      if (action === 'update-cancel') {
        const result = await autoUpdaterService.cancelDownload();
        return { success: result.success, msg: result.error };
      }
      if (action === 'update-install') {
        if (!verifiedUpdateVersion) throw new Error('Enterprise update was not verified');
        await verifyEnterpriseRelease(verifiedUpdateVersion);
        const cached = await autoUpdaterService.restoreDownloadedUpdateIfAvailable();
        if (!cached.success || !cached.data.ready || cached.data.version !== verifiedUpdateVersion) {
          throw new Error('Enterprise update package is not ready');
        }
        try {
          await lifecycle.quiesceWorker();
          await assertWorkerIdle();
        } catch (error) {
          lifecycle.worker?.send({ type: 'enterprise:update-resume' });
          throw error;
        }
        quitting = true;
        autoUpdaterService.setBeforeQuitAndInstall(async () => { await endSession(); });
        try {
          await autoUpdaterService.quitAndInstall();
          return { success: true };
        } catch (error) {
          quitting = false;
          lifecycle.worker?.send({ type: 'enterprise:update-resume' });
          if (!lifecycle.worker) await showLogin();
          throw error;
        }
      }
      throw new Error('Unsupported enterprise update action');
    }
    if (action === 'brand') return client.branding();
    if (
      action === 'resources' &&
      args &&
      typeof args === 'object' &&
      ['ASSISTANT', 'SKILL', 'MCP', 'KNOWLEDGE'].includes((args as { type?: string }).type || '')
    ) {
      return client.resources((args as { type: string }).type);
    }
    if (action === 'documents' && args && typeof args === 'object') {
      const baseId = (args as { baseId?: string }).baseId;
      if (!baseId || !/^[0-9a-f-]{36}$/i.test(baseId)) throw new Error('Invalid base');
      return client.knowledgeDocuments(baseId);
    }
    if (action === 'preview' && args && typeof args === 'object') {
      const { baseId, documentId, version } = args as { baseId?: string; documentId?: string; version?: number };
      if (!baseId || !documentId || !Number.isInteger(version)) throw new Error('Invalid document');
      await client.authorizedDocument(baseId, documentId, version!);
      return client.knowledgePreview(documentId, version!);
    }
    if (action === 'save' && args && typeof args === 'object') {
      const { baseId, documentId, version } = args as { baseId?: string; documentId?: string; version?: number };
      if (!baseId || !documentId || !Number.isInteger(version)) throw new Error('Invalid document');
      await client.authorizedDocument(baseId, documentId, version!);
      const file = await client.knowledgeFile(documentId, version!);
      if (transition || lifecycle.worker !== child) throw new Error('Session closed');
      const safeName =
        path
          .basename(file.filename)
          .replace(/[^\p{L}\p{N}._ -]/gu, '_')
          .slice(0, 100) || 'document.txt';
      const chosen = await dialog.showSaveDialog({ defaultPath: safeName, title: '保存企业资料' });
      if (chosen.canceled || !chosen.filePath) return { saved: false };
      await client.authorizedDocument(baseId, documentId, version!); // Recheck after the user chose a path.
      await fs.writeFile(chosen.filePath, file.bytes);
      return { saved: true, name: safeName };
    }
    if (action === 'download' && args && typeof args === 'object' && downloadRoot) {
      const { baseId, documentId, version } = args as { baseId?: string; documentId?: string; version?: number };
      if (!baseId || !documentId || !Number.isInteger(version)) throw new Error('Invalid document');
      await client.authorizedDocument(baseId, documentId, version!);
      const file = await client.knowledgeFile(documentId, version!);
      if (transition || lifecycle.worker !== child) throw new Error('Session closed');
      await fs.mkdir(downloadRoot, { recursive: true, mode: 0o700 });
      const safeName =
        path
          .basename(file.filename)
          .replace(/[^\p{L}\p{N}._ -]/gu, '_')
          .slice(0, 100) || 'document.txt';
      const targetDir = path.join(downloadRoot, randomUUID());
      await fs.mkdir(targetDir, { mode: 0o700 });
      const target = path.join(targetDir, safeName === '.' || safeName === '..' ? 'document.txt' : safeName);
      await fs.writeFile(target, file.bytes, { mode: 0o600, flag: 'wx' });
      selectedDocuments.set(documentId, { version: version!, baseId });
      return { path: target, name: safeName, version };
    }
    throw new Error('Unsupported enterprise action');
  },
});

function loginHtml(labels: {
  fallbackTitle: string;
  serverUrl: string;
  origin: string;
  rememberPassword: string;
  savedAccount: string;
  forgetAccount: string;
  secureStorageUnavailable: string;
  savedPasswordHint: string;
  versionLabel: string;
}): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"><style>
  html,body{height:100%;margin:0;overflow:hidden}body{display:flex;align-items:center;justify-content:center;font:14px system-ui;background:#f7f8fa;color:#14202e;--brand-primary:#1769aa}main{box-sizing:border-box;width:min(100%,440px);max-height:100%;padding:18px 28px;overflow:auto}.brand{text-align:center}h1{font-size:21px;line-height:1.25;margin:8px 0 3px}label{display:block;margin:10px 0 4px;font-weight:500}input,select{box-sizing:border-box;width:100%;height:36px;padding:6px 10px;border:1px solid #bbc5d0;border-radius:6px;background:white;font:inherit}button{margin-top:12px;padding:9px 22px;background:var(--brand-primary);color:white;border:0;border-radius:6px;cursor:pointer;font:inherit}button.secondary{background:transparent;color:var(--brand-primary);padding:2px 0;margin-top:5px;font-size:12px}button[type=submit]{width:100%;font-weight:600}#brandLogo{width:48px;height:48px;object-fit:contain}#brandName{font-size:17px;font-weight:600;margin-top:3px}#brandCompany,#brandSubtitle{color:#586576;margin:2px 0;font-size:13px}details{margin:12px 0 2px;border:1px solid #d7dee6;border-radius:8px;padding:7px 10px}summary{cursor:pointer;color:#485b70}details label:first-of-type{margin-top:9px}#rememberRow{display:flex;align-items:center;gap:8px;margin-top:11px}#rememberRow input{width:15px;height:15px}#rememberRow label{margin:0;font-size:13px}#status{min-height:18px;margin:8px 0 0;color:#a22;text-align:center;font-size:12px}footer{text-align:center;color:#6c7888;font-size:12px;margin-top:5px}</style></head><body><main><div class="brand"><img id="brandLogo" alt="" hidden><div id="brandName" hidden></div><div id="brandCompany" hidden></div><h1 id="brandTitle">${labels.fallbackTitle}</h1><p id="brandSubtitle" hidden></p></div><form id="form"><details id="connectionSettings"><summary>连接设置（通常无需修改）</summary><label for="serverUrl">${labels.serverUrl}</label><input id="serverUrl" type="url" required><label for="origin">${labels.origin}</label><input id="origin" type="url"></details><div id="savedRow" hidden><label for="savedAccount">${labels.savedAccount}</label><select id="savedAccount"><option value=""></option></select><button id="forgetAccount" type="button" class="secondary">${labels.forgetAccount}</button></div><label for="username">企业账号</label><input id="username" autocomplete="username" required><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required><div id="rememberRow"><input id="rememberPassword" type="checkbox"><label for="rememberPassword">${labels.rememberPassword}</label></div><button type="submit">登录</button></form><p id="status" role="status"></p><footer id="clientVersion">${labels.versionLabel}</footer></main><script>
  const serverUrl=document.getElementById('serverUrl'),origin=document.getElementById('origin'),username=document.getElementById('username'),password=document.getElementById('password'),remember=document.getElementById('rememberPassword'),saved=document.getElementById('savedAccount'),savedRow=document.getElementById('savedRow'),status=document.getElementById('status');let originEdited=false,savedRefresh=0;
  let brandRefresh=0,brandRetryTimer,brandLogoRetries=0;
  function resetBrand(){++brandRefresh;clearTimeout(brandRetryTimer);brandLogoRetries=0;document.getElementById('brandTitle').textContent=${JSON.stringify(labels.fallbackTitle)};document.title=${JSON.stringify(labels.fallbackTitle)};document.getElementById('brandName').hidden=true;document.getElementById('brandCompany').hidden=true;document.getElementById('brandSubtitle').hidden=true;const logo=document.getElementById('brandLogo');logo.hidden=true;logo.removeAttribute('src');document.body.style.removeProperty('--brand-primary');}
  async function refreshBrand(){clearTimeout(brandRetryTimer);const generation=++brandRefresh,requestedUrl=serverUrl.value;let loaded=false,missingLogo=false;try{const brand=await window.enterpriseLogin.branding(requestedUrl);if(generation!==brandRefresh||serverUrl.value!==requestedUrl||!brand)return;loaded=true;missingLogo=!!brand.logoAssetId&&!brand.logoDataUrl;const title=document.getElementById('brandTitle'),name=document.getElementById('brandName'),company=document.getElementById('brandCompany'),subtitle=document.getElementById('brandSubtitle'),logo=document.getElementById('brandLogo');title.textContent=brand.loginTitle||brand.productName;document.title=brand.productName;name.textContent=brand.productName;name.hidden=false;company.textContent=brand.companyName;company.hidden=!brand.companyName;subtitle.textContent=brand.loginSubtitle;subtitle.hidden=!brand.loginSubtitle;logo.hidden=!brand.logoDataUrl;if(brand.logoDataUrl){logo.src=brand.logoDataUrl;logo.alt=brand.productName;}if(brand.primaryColor)document.body.style.setProperty('--brand-primary',brand.primaryColor);}catch{}finally{if(generation===brandRefresh&&serverUrl.value===requestedUrl){if(missingLogo)++brandLogoRetries;else if(loaded)brandLogoRetries=0;if(!loaded||missingLogo&&brandLogoRetries<3)brandRetryTimer=setTimeout(()=>{refreshSaved();refreshBrand();},5000);}}}
  origin.addEventListener('input',()=>{originEdited=true});
  function clearSaved(){++savedRefresh;saved.replaceChildren(new Option('',''));savedRow.hidden=true;password.required=true;password.placeholder='';}
  serverUrl.addEventListener('input',()=>{resetBrand();clearSaved();if(!originEdited){try{origin.value=new URL(serverUrl.value).origin}catch{}}});
  async function refreshSaved(){const generation=++savedRefresh,requestedUrl=serverUrl.value,selected=saved.value;try{const result=await window.enterpriseLogin.savedAccounts(requestedUrl);if(generation!==savedRefresh||serverUrl.value!==requestedUrl)return;remember.disabled=!result.available;if(!result.available){clearSaved();status.textContent=${JSON.stringify(labels.secureStorageUnavailable)};return;}saved.replaceChildren(new Option('',''));for(const account of result.accounts){saved.add(new Option(account,account));}savedRow.hidden=result.accounts.length===0;const next=result.accounts.includes(selected)?selected:(!username.value.trim()&&result.accounts.length===1?result.accounts[0]:'');if(next){saved.value=next;saved.dispatchEvent(new Event('change'));}else{password.required=true;password.placeholder='';}}catch{if(generation===savedRefresh&&serverUrl.value===requestedUrl){clearSaved();remember.disabled=true;}}}
  saved.addEventListener('change',()=>{if(!saved.value)return;username.value=saved.value;password.value='';password.required=false;password.placeholder=${JSON.stringify(labels.savedPasswordHint)};remember.checked=true;});
  username.addEventListener('input',()=>{if(username.value!==saved.value){saved.value='';password.required=true;password.placeholder='';}});
  serverUrl.addEventListener('blur',()=>{refreshSaved();refreshBrand();});
  window.addEventListener('focus',()=>{brandLogoRetries=0;refreshSaved();refreshBrand();});
  document.getElementById('form').addEventListener('invalid',e=>{const settings=document.getElementById('connectionSettings');if(settings.contains(e.target))settings.open=true;},true);
  document.getElementById('forgetAccount').addEventListener('click',async()=>{if(!saved.value)return;await window.enterpriseLogin.forgetAccount(serverUrl.value,saved.value);saved.value='';password.required=true;password.placeholder='';remember.checked=false;await refreshSaved();});
  document.getElementById('form').addEventListener('submit',async e=>{e.preventDefault();status.textContent='正在验证…';try{const result=await window.enterpriseLogin.submit({serverUrl:serverUrl.value,origin:origin.value,username:username.value,password:password.value,rememberPassword:remember.checked,useSavedPassword:!password.value&&saved.value===username.value});status.textContent=result.ok?'登录成功':result.message;}catch{status.textContent='登录失败，请检查账号或连接';}password.value='';});
  refreshSaved();refreshBrand();
  </script></body></html>`;
}

type WebConversationCatalogItem = { key: string; id: string; source: 'enterprise_web'; name: string;
  modified_at: number | null; status: string | null; pinned: boolean };
const isWebConversationId = (value: unknown): value is string => typeof value === 'string' &&
  (/^[0-9a-f]{8}$/i.test(value) || /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value));
type WebSearchItem = { key: string; source: 'enterprise_web'; conversation_id: string; name: string;
  message_id: string; message_created_at: number; preview_text: string };

async function fetchWebConversations(cursor?: string): Promise<{ items: WebConversationCatalogItem[]; next_cursor: string | null }> {
  if (cursor && !isWebConversationId(cursor)) throw new Error('Invalid web conversation cursor');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await ensureWebSession();
    const route = `/enterprise/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await fetch(`${webOrigin}${route}`, {
      headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && attempt === 0) { webSessionCookie = null; continue; }
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 2_000_000) {
      throw new Error('Enterprise web conversations unavailable');
    }
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new Error('Enterprise web conversations invalid');
    const value = JSON.parse(raw) as { items?: Array<Partial<WebConversationCatalogItem>>; next_cursor?: unknown };
    if (!Array.isArray(value.items)) throw new Error('Enterprise web conversations invalid');
    const actor = `${server.serverId}:${client.userId}`;
    const items = value.items.filter((item): item is WebConversationCatalogItem => item.source === 'enterprise_web' &&
      isWebConversationId(item.id) &&
      item.key === `enterprise_web:${actor}:${item.id}` && typeof item.name === 'string' &&
      item.name.length <= 500 && (item.modified_at === null || typeof item.modified_at === 'number') &&
      (item.status === null || typeof item.status === 'string') && typeof item.pinned === 'boolean');
    const nextCursor = isWebConversationId(value.next_cursor)
      ? value.next_cursor : null;
    return { items, next_cursor: nextCursor };
  }
  throw new Error('Enterprise web session unavailable');
}

async function mutateWebConversation(action: 'web-rename' | 'web-pin' | 'web-archive' | 'web-delete',
  id: string, request: { name?: unknown; pinned?: unknown }): Promise<{ updated: true }> {
  const route = action === 'web-rename' ? `/api/conversations/${id}`
    : action === 'web-pin' ? `/api/order/pinned/conversation/${id}`
      : action === 'web-archive' ? `/api/sidebar/conversation/${id}/archive`
        : `/api/conversations/${id}`;
  const method = action === 'web-rename' ? 'PATCH'
    : action === 'web-pin' ? (request.pinned ? 'PUT' : 'DELETE')
      : action === 'web-archive' ? 'POST' : 'DELETE';
  const body = action === 'web-rename' ? JSON.stringify({ name: (request.name as string).trim(), name_source: 'user' }) : undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await ensureWebSession();
    // The user-order pin route accepts an item ID; first ask this employee's
    // Core for the conversation so an arbitrary foreign or stale ID cannot be pinned.
    if (action === 'web-pin') {
      const owned = await fetch(`${webOrigin}/api/conversations/${id}`, {
        headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (owned.status === 401 && attempt === 0) { webSessionCookie = null; continue; }
      if (!owned.ok) throw new Error('Web conversation unavailable');
      await owned.body?.cancel();
    }
    const response = await fetch(`${webOrigin}${route}`, {
      method, headers: { Origin: webOrigin!, Cookie: cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && attempt === 0) { webSessionCookie = null; continue; }
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 2_000_000) {
      throw new Error('Enterprise web conversation update unavailable');
    }
    const raw = await response.text();
    if (raw.length > 2_000_000 || (JSON.parse(raw) as { success?: unknown }).success !== true) {
      throw new Error('Enterprise web conversation update invalid');
    }
    return { updated: true };
  }
  throw new Error('Enterprise web session unavailable');
}

async function fetchWebSearch(keyword: string, page: number): Promise<{ items: WebSearchItem[]; has_more: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const cookie = await ensureWebSession();
    const route = `/enterprise/search?keyword=${encodeURIComponent(keyword)}&page=${page}`;
    const response = await fetch(`${webOrigin}${route}`, {
      headers: { Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 && attempt === 0) { webSessionCookie = null; continue; }
    if (!response.ok || Number(response.headers.get('content-length') || 0) > 2_000_000) {
      throw new Error('Enterprise web search unavailable');
    }
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new Error('Enterprise web search invalid');
    const value = JSON.parse(raw) as { items?: Array<Partial<WebSearchItem>>; has_more?: unknown };
    if (!Array.isArray(value.items)) throw new Error('Enterprise web search invalid');
    const actor = `${server.serverId}:${client.userId}`;
    const items = value.items.filter((item): item is WebSearchItem => item.source === 'enterprise_web' &&
      isWebConversationId(item.conversation_id) &&
      item.key === `enterprise_web:${actor}:${item.conversation_id}` &&
      typeof item.name === 'string' && item.name.length <= 500 &&
      typeof item.message_id === 'string' && item.message_id.length <= 100 &&
      typeof item.message_created_at === 'number' && typeof item.preview_text === 'string' &&
      item.preview_text.length <= 500);
    return { items, has_more: value.has_more === true };
  }
  throw new Error('Enterprise web session unavailable');
}

async function clientVersionLabel(): Promise<string> {
  const version = app.getVersion();
  if (!app.isPackaged) return `客户端版本 ${version} · 开发版`;
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(process.resourcesPath, 'app.asar'))) hash.update(chunk);
    return `客户端版本 ${version} · 构建 ${hash.digest('hex').slice(0, 8)}`;
  } catch {
    return `客户端版本 ${version}`;
  }
}

async function showLogin(): Promise<void> {
  if (!ownsInstance || quitting || loginWindow) return;
  if (process.platform === 'darwin') void app.dock?.show();
  server = await readServerConfig(profileRoot);
  const loginText = loginLocales[normalizeLanguageCode(app.getLocale())] || enUSLogin;
  const versionLabel = await clientVersionLabel();
  loginWindow = new BrowserWindow({
    width: 500,
    height: 680,
    center: true,
    resizable: false,
    title: loginText.enterpriseAccountLabel,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out/preload/enterpriseLogin.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'enterprise-login',
    },
  });
  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!lifecycle.worker && !quitting) app.quit();
  });
  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await loginWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      loginHtml({
        fallbackTitle: loginText.enterpriseAccountLabel,
        serverUrl: loginText.enterpriseServerUrl,
        origin: loginText.enterpriseOrigin,
        rememberPassword: loginText.enterpriseRememberPassword,
        savedAccount: loginText.enterpriseSavedAccount,
        forgetAccount: loginText.enterpriseForgetAccount,
        secureStorageUnavailable: loginText.enterpriseSecureStorageUnavailable,
        savedPasswordHint: loginText.enterpriseSavedPasswordHint,
        versionLabel,
      })
    )}`
  );
  await loginWindow.webContents.executeJavaScript(
    `document.getElementById('serverUrl').value=${JSON.stringify(server.baseUrl)};document.getElementById('origin').value=${JSON.stringify(server.origin)};refreshSaved();refreshBrand();`
  );
  // RC2 owns the required Origin. Refresh an old saved value without delaying
  // the login window or overwriting a value the employee has already edited.
  if (server.baseUrl && !process.env.AION_ENTERPRISE_ORIGIN) {
    const window = loginWindow;
    const baseUrl = server.baseUrl;
    const previousOrigin = server.origin;
    void new Rc2Client(baseUrl)
      .bootstrap()
      .then((bootstrap) => {
        if (!window || window.isDestroyed() || !bootstrap.requiredOrigin) return;
        const requiredOrigin = normalizeServer(baseUrl, bootstrap.requiredOrigin).origin;
        return window.webContents.executeJavaScript(
          `if(document.getElementById('serverUrl').value===${JSON.stringify(baseUrl)}&&` +
            `document.getElementById('origin').value===${JSON.stringify(previousOrigin)})` +
            `document.getElementById('origin').value=${JSON.stringify(requiredOrigin)};`
        );
      })
      .catch(() => {});
  }
}

function validLoginSender(sender: Electron.WebContents): boolean {
  return !!loginWindow && sender === loginWindow.webContents && !lifecycle.worker;
}

function securePasswordStorageAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  );
}

ipcMain.handle('enterprise:saved-accounts', async (event, serverUrl: string) => {
  if (!validLoginSender(event.sender)) return { available: false, accounts: [] };
  // A synchronous Keychain availability probe can block the entire Electron
  // main thread while macOS waits for an unlock prompt. Only access it after
  // the employee explicitly chooses a saved password or opts to remember one.
  const available = process.platform === 'darwin' || securePasswordStorageAvailable();
  if (!available) return { available, accounts: [] };
  try {
    const target = normalizeServer(serverUrl);
    const bootstrap = await new Rc2Client(target.baseUrl).bootstrap();
    return { available, accounts: await listRememberedAccountNames(profileRoot, bootstrap.serverId) };
  } catch {
    return { available, accounts: [] };
  }
});

ipcMain.handle('enterprise:branding', async (event, serverUrl: string) => {
  if (!validLoginSender(event.sender)) return null;
  try {
    const target = normalizeServer(serverUrl);
    return await new Rc2Client(target.baseUrl).branding();
  } catch {
    return null;
  }
});

ipcMain.handle('enterprise:forget-account', async (event, serverUrl: string, username: string) => {
  if (!validLoginSender(event.sender) || typeof username !== 'string') return false;
  try {
    const target = normalizeServer(serverUrl);
    const bootstrap = await new Rc2Client(target.baseUrl).bootstrap();
    await forgetRememberedAccount(profileRoot, bootstrap.serverId, username);
    return true;
  } catch {
    return false;
  }
});

function loginFailureMessage(error: unknown): string {
  const labels = loginLocales[normalizeLanguageCode(app.getLocale())] || enUSLogin;
  const code = (error as { code?: string })?.code;
  const key: keyof LoginLabels['enterpriseErrors'] =
    code === 'CERTIFICATE'
      ? 'certificate'
      : code === 'VERSION'
        ? 'version'
        : code === 'ORIGIN'
          ? 'origin'
          : code === 'CREDENTIALS'
            ? 'credentials'
            : code === 'CONNECTION'
              ? 'connection'
              : /Enterprise server|Invalid enterprise Origin|Invalid URL/i.test((error as Error)?.message || '')
                ? 'address'
                : 'unknown';
  return labels.enterpriseErrors[key];
}

async function ensureWebSession(): Promise<string> {
  if (!webOrigin || new URL(webOrigin).protocol !== 'https:') throw new Error('Enterprise web requires HTTPS');
  if (webSessionCookie) return webSessionCookie;
  if (!client.cookie || !client.userId || !server.serverId) throw new Error('RC2 session unavailable');
  const response = await fetch(`${webOrigin}/enterprise/desktop-session`, {
    method: 'POST',
    headers: { Origin: webOrigin, 'x-aion-rc2-session': client.cookie },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const rawCookie = response.headers.getSetCookie?.().find((item) => item.startsWith('__Host-aion-enterprise-web='));
  const cookie = rawCookie?.split(';', 1)[0];
  const value = await response.json().catch((): null => null) as { actor?: { serverId?: string; userId?: string } } | null;
  if (!response.ok || !cookie || !/^__Host-aion-enterprise-web=[a-f0-9]{64}$/.test(cookie) ||
      value?.actor?.serverId !== server.serverId || value.actor.userId !== client.userId) {
    throw new Error('Enterprise web session unavailable');
  }
  webSessionCookie = cookie;
  return cookie;
}

async function openWebConversation(id: string, cookie: string): Promise<void> {
  return openWebPage(`/conversation/${encodeURIComponent(id)}`, cookie);
}

async function openWebPage(route: string, cookie: string): Promise<void> {
  if (!webOrigin) throw new Error('Enterprise web unavailable');
  const origin = webOrigin;
  if (!webWindow || webWindow.isDestroyed()) {
    const window = new BrowserWindow({ width: 1150, height: 800, minWidth: 800, minHeight: 600,
      title: '网页对话', webPreferences: { partition: `enterprise-web-${randomUUID()}`,
        nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const blockExternalNavigation = (event: Electron.Event, url: string) => {
      try { if (new URL(url).origin !== origin) event.preventDefault(); }
      catch { event.preventDefault(); }
    };
    window.webContents.on('will-navigate', blockExternalNavigation);
    window.webContents.on('will-redirect', blockExternalNavigation);
    window.on('closed', () => { if (webWindow === window) webWindow = null; });
    webWindow = window;
  }
  const [name, value] = cookie.split('=', 2);
  await webWindow.webContents.session.cookies.set({ url: origin, name, value,
    path: '/', secure: true, httpOnly: true, sameSite: 'strict' });
  await webWindow.loadURL(`${origin}/#${route}`);
  webWindow.show();
  webWindow.focus();
}

async function endSession(): Promise<void> {
  if (transition) return transition;
  transition = (async () => {
    sessionGeneration += 1;
    webWindow?.destroy();
    webWindow = null;
    if (webSessionCookie && webOrigin) {
      await fetch(`${webOrigin}/enterprise/logout`, { method: 'POST',
        headers: { Origin: webOrigin, Cookie: webSessionCookie },
        redirect: 'error', signal: AbortSignal.timeout(3000) }).catch(() => {});
    }
    webSessionCookie = null;
    webOrigin = null;
    updateServerId = null;
    updateFeedUrl = null;
    updateChannel = null;
    verifiedUpdateVersion = null;
    workerCorePort = null;
    workerCoreToken = null;
    autoUpdaterService.reset();
    await lifecycle.stop();
    selectedDocuments.clear();
    if (downloadRoot) await fs.rm(downloadRoot, { recursive: true, force: true });
    downloadRoot = null;
    await modelProxy?.stop();
    modelProxy = null;
    await mcpProxy?.stop();
    mcpProxy = null;
    if (skillStage) await fs.rm(skillStage, { recursive: true, force: true });
    skillStage = null;
    if (assistantsStage) await fs.rm(assistantsStage, { force: true });
    assistantsStage = null;
    activeAssistantVersions = [];
    activeSkillId = null;
    activeSkillVersion = null;
    activeMcpIds = null;
    activeModelId = null;
    await client.logout().catch(() => {});
    if (!quitting) await showLogin();
  })();
  try {
    await transition;
  } finally {
    transition = null;
  }
}

async function verifyEnterpriseRelease(version: string): Promise<void> {
  if (!updateFeedUrl || !updateChannel || !updateServerId) throw new Error('Enterprise update feed unavailable');
  const response = await fetch(new URL('enterprise-release.json', updateFeedUrl), {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || Number(response.headers.get('content-length') || 0) > 16_384) {
    throw new Error('Enterprise release metadata unavailable');
  }
  const payload = await response.text();
  if (payload.length > 16_384) throw new Error('Enterprise release metadata too large');
  const release = parseEnterpriseReleaseManifest(JSON.parse(payload), {
    serverId: updateServerId, channel: updateChannel, platform: process.platform, arch: process.arch,
  });
  if (release.version !== version) throw new Error('Enterprise release version changed');
}

async function assertWorkerIdle(): Promise<void> {
  if (!workerCorePort || !workerCoreToken || !lifecycle.worker) throw new Error('Employee Core is unavailable');
  const response = await fetch(`http://127.0.0.1:${workerCorePort}/api/conversations/active-count`, {
    headers: { 'x-aion-enterprise-local-token': workerCoreToken },
    signal: AbortSignal.timeout(5000),
  });
  const payload: { data?: { count?: number } } | null = await response.json().catch((): null => null);
  const count = payload?.data?.count;
  if (!response.ok || !Number.isSafeInteger(count) || count < 0) throw new Error('Unable to verify running tasks');
  if (count !== 0) throw new Error('Wait for running Agent tasks before installing the update');
}

async function configureEnterpriseUpdates(serverId: string): Promise<void> {
  updateServerId = null;
  updateFeedUrl = null;
  updateChannel = null;
  verifiedUpdateVersion = null;
  autoUpdaterService.reset();
  if (!app.isPackaged) return;
  const config = await loadEnterpriseUpdateConfig(path.join(process.resourcesPath, 'enterprise-update.json'), serverId);
  if (!config) return;
  autoUpdaterService.configureEnterpriseFeed(config.feedUrl, config.channel);
  autoUpdaterService.setStatusBroadcastCallback((status) => {
    const worker = lifecycle.worker;
    if (worker?.connected) worker.send({ type: 'enterprise:update-status', status });
  });
  updateServerId = serverId;
  updateFeedUrl = config.feedUrl;
  updateChannel = config.channel;
}

ipcMain.handle(
  'enterprise:login',
  async (
    event,
    credentials: {
      username: string;
      password: string;
      serverUrl: string;
      origin?: string;
      rememberPassword?: boolean;
      useSavedPassword?: boolean;
    }
  ) => {
    if (!validLoginSender(event.sender)) return { ok: false, message: '登录窗口已失效' };
    if (
      !credentials ||
      typeof credentials.username !== 'string' ||
      typeof credentials.password !== 'string' ||
      credentials.username.length > 100 ||
      credentials.password.length > 1024
    )
      return { ok: false, message: '请输入账号和密码' };
    try {
      server = normalizeServer(credentials.serverUrl || server.baseUrl, credentials.origin || '');
      client = new Rc2Client(server.baseUrl, server.origin);
      const bootstrap = await client.bootstrap();
      const password =
        credentials.password ||
        (credentials.useSavedPassword && securePasswordStorageAvailable()
          ? await readRememberedPassword(profileRoot, bootstrap.serverId, credentials.username, safeStorage)
          : null);
      if (!password) return { ok: false, message: '请输入账号和密码' };
      const actor = await client.login({ username: credentials.username, password });
      server = { ...server, serverId: actor.serverId, origin: client.origin };
      if (actor.mustChangePassword) {
        await client.logout();
        return { ok: false, message: '请先在企业后台修改密码' };
      }
      const models = await client.availableModels();
      const availableAssistants = await client.resources('ASSISTANT');
      const selectedAssistants = availableAssistants
        .filter(
          (item: { id: string; source: string }) =>
            item.source !== 'personal' ||
            item.id === (process.env.AION_ENTERPRISE_ASSISTANT_ID || pilotPointers.assistantId)
        )
        .sort(
          (a: { source: string }, b: { source: string }) =>
            Number(b.source === 'enterprise') - Number(a.source === 'enterprise')
        )
        .slice(0, 20);
      const assistantCandidates = [];
      for (const item of selectedAssistants) {
        const resource = await client.authorizedResource(item.id, 'ASSISTANT');
        const instruction = resource.config?.instruction;
        if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) continue;
        assistantCandidates.push({
          id: item.id,
          name: item.name,
          description: item.description,
          source: item.source,
          version: item.version,
          modelId: resource.config?.modelId,
          instruction,
          skillIds: resource.config?.skillIds || [],
          mcpIds: resource.config?.mcpIds || [],
        });
      }
      const pilotModelId = models.some((item: { id: string }) => item.id === pilotPointers.modelId)
        ? pilotPointers.modelId : undefined;
      const requestedModelId =
        process.env.AION_ENTERPRISE_MODEL_ID ||
        assistantCandidates.find((item) => models.some((model: { id: string }) => model.id === item.modelId))
          ?.modelId ||
        pilotModelId;
      const model = models.find((item: { id: string }) => !requestedModelId || item.id === requestedModelId);
      if (!model) throw new Error('No authorized enterprise model');
      activeModelId = model.id;
      const assistants = assistantCandidates.filter((item) => item.modelId === model.id);
      const profile = await prepareProfile(profileRoot, server.serverId, actor.userId);
      downloadRoot = path.join(profile.dir, 'enterprise-downloads');
      let skill: { path: string; name: string; id: string; version: number } | null = null;
      const skillId =
        process.env.AION_ENTERPRISE_SKILL_ID || assistants.flatMap((item) => item.skillIds)[0] || pilotPointers.skillId;
      if (skillId) {
        try {
          const resource = await client.authorizedResource(skillId, 'SKILL');
          const name = resource.config?.manifest?.name;
          const source = resource.config?.source;
          if (
            typeof name !== 'string' ||
            !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
            typeof source !== 'string' ||
            source.length > 24_000 ||
            !Number.isInteger(resource.version)
          )
            throw new Error('Invalid RC2 Skill');
          skillStage = path.join(profile.dir, 'enterprise-skill-stage');
          const skillDir = path.join(skillStage, name);
          await fs.mkdir(skillDir, { recursive: true, mode: 0o700 });
          await fs.writeFile(path.join(skillDir, 'SKILL.md'), source, { mode: 0o600 });
          skill = { path: skillDir, name, id: skillId, version: resource.version };
          activeSkillId = skillId;
          activeSkillVersion = resource.version;
        } catch {
          console.warn('[Enterprise] optional Skill unavailable for this employee');
        }
      }
      const resourceId =
        process.env.AION_ENTERPRISE_MCP_RESOURCE_ID ||
        assistants.flatMap((item) => item.mcpIds)[0] ||
        pilotPointers.mcpResourceId;
      if (resourceId) {
        const explicitConnectionId =
          process.env.AION_ENTERPRISE_MCP_CONNECTION_ID ||
          (resourceId === pilotPointers.mcpResourceId ? pilotPointers.mcpConnectionId : null);
        try {
          const mcpResource = await client.authorizedResource(resourceId, 'MCP');
          const mcpConnectionId = explicitConnectionId || (await client.readyMcpConnection(resourceId)).id;
          await client.authorizedMcpConnection(mcpConnectionId, resourceId);
          mcpProxy = new EnterpriseMcpProxy({
            client,
            connectionId: mcpConnectionId,
            onRevoked: () => {
              void endSession();
            },
          });
          activeMcpIds = { resourceId, connectionId: mcpConnectionId, version: mcpResource.version };
        } catch {
          console.warn('[Enterprise] optional MCP unavailable for this employee');
        }
      }
      const runnableAssistants = assistants.filter(
        (item) =>
          item.skillIds.every((id: string) => id === activeSkillId) &&
          item.mcpIds.every((id: string) => id === activeMcpIds?.resourceId)
      );
      if (runnableAssistants.length) {
        assistantsStage = path.join(profile.dir, 'enterprise-assistants-stage.json');
        await fs.writeFile(assistantsStage, JSON.stringify(runnableAssistants), { mode: 0o600 });
        activeAssistantVersions = runnableAssistants.map((item) => ({ id: item.id, version: item.version }));
      }
      modelProxy = new EnterpriseModelProxy({
        client,
        model,
        onRevoked: () => {
          void endSession();
        },
      });
      const proxy = await modelProxy.start();
      const mcp = mcpProxy
        ? { ...(await mcpProxy.start()), resourceId: activeMcpIds!.resourceId, version: activeMcpIds!.version }
        : null;
      sessionGeneration += 1;
      await saveServerConfig(profileRoot, server);
      webOrigin = null;
      try {
        const webConfig = await loadEnterpriseWebConfig(app.isPackaged
          ? path.join(process.resourcesPath, 'enterprise-web.json')
          : path.join(app.getAppPath(), 'resources/enterprise/web.json'), actor.serverId);
        if (webConfig && webConfig.publicOrigin === new URL(server.baseUrl).origin) {
          throw new Error('Enterprise web origin must differ from RC2');
        }
        webOrigin = webConfig?.publicOrigin || null;
      } catch (error) {
        console.warn('[Enterprise] web origin unavailable:', error instanceof Error ? error.message : 'unknown');
      }
      workerCorePort = null;
      workerCoreToken = profile.localToken;
      lifecycle.start({
        profileDir: profile.dir,
        localToken: profile.localToken,
        identity: {
          userId: actor.userId,
          username: credentials.username,
          serverId: actor.serverId,
          serverUrl: server.baseUrl,
          webOrigin,
        },
        model: { ...model, ...proxy },
        skill,
        mcp,
        assistantsPath: assistantsStage,
      });
      await configureEnterpriseUpdates(actor.serverId).catch((error) => {
        console.warn('[Enterprise] update feed unavailable:', error instanceof Error ? error.message : 'unknown');
      });
      try {
        if (credentials.rememberPassword && securePasswordStorageAvailable()) {
          await saveRememberedAccount(
            profileRoot,
            actor.serverId,
            actor.userId,
            credentials.username,
            password,
            safeStorage
          );
        } else if (!credentials.rememberPassword) {
          await forgetRememberedAccount(profileRoot, actor.serverId, credentials.username);
        }
      } catch {
        console.warn('[Enterprise] secure password storage unavailable');
      }
      loginWindow?.close();
      if (process.platform === 'darwin') void app.dock?.hide();
      return { ok: true };
    } catch (error) {
      await modelProxy?.stop();
      modelProxy = null;
      await mcpProxy?.stop();
      mcpProxy = null;
      if (skillStage) await fs.rm(skillStage, { recursive: true, force: true });
      skillStage = null;
      if (assistantsStage) await fs.rm(assistantsStage, { force: true });
      assistantsStage = null;
      activeAssistantVersions = [];
      activeSkillId = null;
      activeSkillVersion = null;
      activeMcpIds = null;
      activeModelId = null;
      workerCorePort = null;
      workerCoreToken = null;
      webOrigin = null;
      webSessionCookie = null;
      if (downloadRoot) await fs.rm(downloadRoot, { recursive: true, force: true });
      downloadRoot = null;
      selectedDocuments.clear();
      await client.logout().catch(() => {});
      return { ok: false, message: loginFailureMessage(error) };
    }
  }
);

void app.whenReady().then(async () => {
  pilotPointers = await readPilotResourcePointers(
    app.isPackaged
      ? path.join(process.resourcesPath, 'enterprise-pilot.json')
      : path.join(app.getAppPath(), 'resources/enterprise/pilot.json')
  );
  await showLogin();
});
// The supervisor intentionally has no window while an employee worker runs.
// Keep it alive after closing the login window so it can monitor RC2 revocation.
app.on('window-all-closed', () => {});
app.on('second-instance', () => {
  if (loginWindow) {
    loginWindow.show();
    loginWindow.focus();
  }
});
const poll = setInterval(async () => {
  if (!lifecycle.worker || transition) return;
  const seen = sessionGeneration;
  try {
    await client.me();
    if (activeModelId && !(await client.availableModels()).some((item: { id: string }) => item.id === activeModelId)) {
      throw new Error('Enterprise model revoked');
    }
    if (activeSkillId) {
      const skill = await client.authorizedResource(activeSkillId, 'SKILL');
      assertLoadedResourceVersion(skill, activeSkillVersion);
    }
    for (const item of activeAssistantVersions) {
      const assistant = await client.authorizedResource(item.id, 'ASSISTANT');
      assertLoadedResourceVersion(assistant, item.version);
    }
    if (activeMcpIds) {
      const mcp = await client.authorizedResource(activeMcpIds.resourceId, 'MCP');
      assertLoadedResourceVersion(mcp, activeMcpIds.version);
      await client.authorizedMcpConnection(activeMcpIds.connectionId, activeMcpIds.resourceId);
    }
    for (const [id, { version, baseId }] of selectedDocuments) await client.authorizedDocument(baseId, id, version);
  } catch (error) {
    console.warn('[Enterprise] RC2 session check failed', error instanceof Error ? error.message : 'unknown');
    if (seen === sessionGeneration && lifecycle.worker) await endSession();
  }
}, 5000);
poll.unref();

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  clearInterval(poll);
  // The first quit is cancelled while the employee session is cleaned up.
  // Exit explicitly afterward: a second app.quit() can leave the windowless
  // supervisor running on macOS even though its login window has closed.
  void endSession()
    .catch(() => console.warn('[Enterprise] cleanup before quit failed'))
    .finally(() => app.exit(0));
});
