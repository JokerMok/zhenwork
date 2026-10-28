import faLogin from '../../desktop/src/renderer/services/i18n/locales/fa-IR/login.json' with { type: 'json' };
import frLogin from '../../desktop/src/renderer/services/i18n/locales/fr-FR/login.json' with { type: 'json' };
import esLogin from '../../desktop/src/renderer/services/i18n/locales/es-ES/login.json' with { type: 'json' };
import deLogin from '../../desktop/src/renderer/services/i18n/locales/de-DE/login.json' with { type: 'json' };
import ptLogin from '../../desktop/src/renderer/services/i18n/locales/pt-BR/login.json' with { type: 'json' };
import ukLogin from '../../desktop/src/renderer/services/i18n/locales/uk-UA/login.json' with { type: 'json' };
import ruLogin from '../../desktop/src/renderer/services/i18n/locales/ru-RU/login.json' with { type: 'json' };
import trLogin from '../../desktop/src/renderer/services/i18n/locales/tr-TR/login.json' with { type: 'json' };
import koLogin from '../../desktop/src/renderer/services/i18n/locales/ko-KR/login.json' with { type: 'json' };
import zhTwLogin from '../../desktop/src/renderer/services/i18n/locales/zh-TW/login.json' with { type: 'json' };
import jaLogin from '../../desktop/src/renderer/services/i18n/locales/ja-JP/login.json' with { type: 'json' };
import enLogin from '../../desktop/src/renderer/services/i18n/locales/en-US/login.json' with { type: 'json' };
import zhLogin from '../../desktop/src/renderer/services/i18n/locales/zh-CN/login.json' with { type: 'json' };
import deCommon from '../../desktop/src/renderer/services/i18n/locales/de-DE/common.json' with { type: 'json' };
import deWorkspace from '../../desktop/src/renderer/services/i18n/locales/de-DE/workspace.json' with { type: 'json' };
import enCommon from '../../desktop/src/renderer/services/i18n/locales/en-US/common.json' with { type: 'json' };
import enWorkspace from '../../desktop/src/renderer/services/i18n/locales/en-US/workspace.json' with { type: 'json' };
import esCommon from '../../desktop/src/renderer/services/i18n/locales/es-ES/common.json' with { type: 'json' };
import esWorkspace from '../../desktop/src/renderer/services/i18n/locales/es-ES/workspace.json' with { type: 'json' };
import faCommon from '../../desktop/src/renderer/services/i18n/locales/fa-IR/common.json' with { type: 'json' };
import faWorkspace from '../../desktop/src/renderer/services/i18n/locales/fa-IR/workspace.json' with { type: 'json' };
import frCommon from '../../desktop/src/renderer/services/i18n/locales/fr-FR/common.json' with { type: 'json' };
import frWorkspace from '../../desktop/src/renderer/services/i18n/locales/fr-FR/workspace.json' with { type: 'json' };
import jaCommon from '../../desktop/src/renderer/services/i18n/locales/ja-JP/common.json' with { type: 'json' };
import jaWorkspace from '../../desktop/src/renderer/services/i18n/locales/ja-JP/workspace.json' with { type: 'json' };
import koCommon from '../../desktop/src/renderer/services/i18n/locales/ko-KR/common.json' with { type: 'json' };
import koWorkspace from '../../desktop/src/renderer/services/i18n/locales/ko-KR/workspace.json' with { type: 'json' };
import ptCommon from '../../desktop/src/renderer/services/i18n/locales/pt-BR/common.json' with { type: 'json' };
import ptWorkspace from '../../desktop/src/renderer/services/i18n/locales/pt-BR/workspace.json' with { type: 'json' };
import ruCommon from '../../desktop/src/renderer/services/i18n/locales/ru-RU/common.json' with { type: 'json' };
import ruWorkspace from '../../desktop/src/renderer/services/i18n/locales/ru-RU/workspace.json' with { type: 'json' };
import trCommon from '../../desktop/src/renderer/services/i18n/locales/tr-TR/common.json' with { type: 'json' };
import trWorkspace from '../../desktop/src/renderer/services/i18n/locales/tr-TR/workspace.json' with { type: 'json' };
import ukCommon from '../../desktop/src/renderer/services/i18n/locales/uk-UA/common.json' with { type: 'json' };
import ukWorkspace from '../../desktop/src/renderer/services/i18n/locales/uk-UA/workspace.json' with { type: 'json' };
import zhCommon from '../../desktop/src/renderer/services/i18n/locales/zh-CN/common.json' with { type: 'json' };
import zhWorkspace from '../../desktop/src/renderer/services/i18n/locales/zh-CN/workspace.json' with { type: 'json' };
import zhTwCommon from '../../desktop/src/renderer/services/i18n/locales/zh-TW/common.json' with { type: 'json' };
import zhTwWorkspace from '../../desktop/src/renderer/services/i18n/locales/zh-TW/workspace.json' with { type: 'json' };

type ReadinessBrand = { productName: string; primaryColor: string; logoDataUrl: string };
type ReadinessMessages = {
  status: {
    preparing: string;
    preparationFailed: string;
    capabilityForbidden: string;
    environmentUnavailable: string;
    connectionRecovering: string;
    bootstrapLoadFailed: string;
    identityExpired: string;
    preparationQueued: string;
    preparationStarting: string;
    preparationReady: string;
    preparationTimedOut: string;
    preparationElapsed: string;
    preparationTechnicalDetails: string;
  };
  errors: {
    load: string;
    action: string;
    noCapability: string;
    prepareFailed: string;
    noModel?: string;
    authentication?: string;
    forbidden?: string;
  };
};
type LocaleBundle = { common: { retry: string; loading: string }; workspace: ReadinessMessages; login: typeof enLogin };
const FALLBACK_PRODUCT = 'ZhenWork';
const locales = {
  'de-DE': { common: deCommon, workspace: deWorkspace, login: deLogin },
  'en-US': { common: enCommon, workspace: enWorkspace, login: enLogin },
  'es-ES': { common: esCommon, workspace: esWorkspace, login: esLogin },
  'fa-IR': { common: faCommon, workspace: faWorkspace, login: faLogin },
  'fr-FR': { common: frCommon, workspace: frWorkspace, login: frLogin },
  'ja-JP': { common: jaCommon, workspace: jaWorkspace, login: jaLogin },
  'ko-KR': { common: koCommon, workspace: koWorkspace, login: koLogin },
  'pt-BR': { common: ptCommon, workspace: ptWorkspace, login: ptLogin },
  'ru-RU': { common: ruCommon, workspace: ruWorkspace, login: ruLogin },
  'tr-TR': { common: trCommon, workspace: trWorkspace, login: trLogin },
  'uk-UA': { common: ukCommon, workspace: ukWorkspace, login: ukLogin },
  'zh-CN': { common: zhCommon, workspace: zhWorkspace, login: zhLogin },
  'zh-TW': { common: zhTwCommon, workspace: zhTwWorkspace, login: zhTwLogin },
} satisfies Record<string, LocaleBundle>;
type SupportedLocale = keyof typeof locales;

function localeFor(acceptLanguage: string): SupportedLocale {
  const requested = acceptLanguage
    .split(',')
    .map((part) => part.split(';')[0]?.trim())
    .filter(Boolean);
  for (const language of requested) {
    const exact = Object.keys(locales).find((candidate) => candidate.toLowerCase() === language!.toLowerCase());
    if (exact) return exact as SupportedLocale;
    const base = language!.split('-')[0]?.toLowerCase();
    if (base === 'zh') return /(?:tw|hk|hant)/i.test(language!) ? 'zh-TW' : 'zh-CN';
    const match = Object.keys(locales).find((candidate) => candidate.toLowerCase().startsWith(`${base}-`));
    if (match) return match as SupportedLocale;
  }
  return 'en-US';
}

export function enterpriseLoginLocale(hint: string) {
  const locale = localeFor(hint);
  return { locale, copy: locales[locale].login };
}

const html = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!
  );
const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
const productName = (brand: ReadinessBrand | null): string => brand?.productName || FALLBACK_PRODUCT;
const brandColor = (brand: ReadinessBrand | null): string => brand?.primaryColor || '#2563eb';
const monogramFavicon = (product: string, color: string): string => {
  const initial = Array.from(product.trim())[0]?.toUpperCase() || 'Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${color}"/><text x="32" y="43" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="white">${html(initial)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
const favicon = (brand: ReadinessBrand | null, product: string, color: string): string =>
  brand?.logoDataUrl || monogramFavicon(product, color);
const brandVisual = (brand: ReadinessBrand | null, product: string): string =>
  brand?.logoDataUrl
    ? `<img src="${brand.logoDataUrl}" alt="" width="48" height="48">`
    : `<span class="brand-mark" aria-hidden="true">${html(Array.from(product)[0] || 'Z')}</span>`;

export function enterpriseBootstrapShell(
  acceptLanguage: string,
  nonce: string,
  brand: ReadinessBrand | null
): { head: string; body: string } {
  const { common, workspace } = locales[localeFor(acceptLanguage)];
  const product = productName(brand);
  const color = brandColor(brand);
  const icon = favicon(brand, product, color);
  const copy = json({ failed: workspace.status.bootstrapLoadFailed, retry: common.retry });
  const monitor = `(()=>{const copy=${copy};const root=document.getElementById('root');const shell=root?.querySelector('[data-enterprise-bootstrap]');const status=document.getElementById('enterprise-bootstrap-status');const progress=document.getElementById('enterprise-bootstrap-progress');const error=document.querySelector('[data-testid="enterprise-bootstrap-error"]');const retry=document.querySelector('[data-testid="enterprise-bootstrap-retry"]');if(!root||!shell||!status||!progress||!error||!retry)return;const started=performance.now();performance.mark?.('enterprise:bootstrap_start');let finished=false;let observer;let monitorTimer;const finish=(phase,code)=>{if(finished)return;finished=true;performance.mark?.('enterprise:bootstrap_'+phase);window.removeEventListener('error',onResourceError,true);window.removeEventListener('unhandledrejection',onRejection);observer?.disconnect();if(monitorTimer)clearTimeout(monitorTimer);const entry=JSON.stringify({event:'enterprise_bootstrap_shell',phase,durationMs:Math.max(0,Math.round(performance.now()-started)),code});if(phase==='asset_failed')console.warn('[Enterprise bootstrap]',entry);else console.info('[Enterprise bootstrap]',entry);};const fail=()=>{if(finished)return;status.textContent=copy.failed;progress.hidden=true;error.hidden=false;finish('asset_failed','BOOTSTRAP_ASSET_FAILED');};const onResourceError=event=>{const target=event.target;if(target instanceof HTMLScriptElement||target instanceof HTMLLinkElement)fail();};const onRejection=event=>{const message=String(event.reason?.message||event.reason||'');if(/dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to fetch.*module/i.test(message))fail();};window.addEventListener('error',onResourceError,true);window.addEventListener('unhandledrejection',onRejection);retry.addEventListener('click',()=>location.reload());observer=new MutationObserver(()=>{if(root.childElementCount>0&&!root.contains(shell)){finish('mounted','RENDERED');}});observer.observe(root,{childList:true,subtree:true});monitorTimer=setTimeout(()=>finish('monitor_expired','MONITOR_EXPIRED'),600000);})();`;
  return {
    head: `<title>${html(product)}</title><link rel="icon" href="${icon}"><style nonce="${nonce}">body{margin:0}.enterprise-bootstrap{--enterprise-brand:${color};height:100dvh;display:flex;background:var(--color-bg-1,#fff);color:var(--color-text-2,#52647c);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.enterprise-bootstrap-nav{width:224px;box-sizing:border-box;flex:none;padding:24px 20px;background:var(--color-bg-2,#f5f6f8)}.enterprise-bootstrap-line{height:14px;width:75%;margin:24px 0;background:var(--color-fill-2,#e9edf2);border-radius:6px}.enterprise-bootstrap-main{flex:1;min-width:0;display:flex;flex-direction:column}.enterprise-bootstrap-header{height:52px;border-bottom:1px solid var(--color-border-2,#e9edf2)}.enterprise-bootstrap-space{flex:1}.enterprise-bootstrap-input{width:80%;max-width:880px;margin:0 auto 28px}.enterprise-bootstrap-input .enterprise-bootstrap-line{height:64px;width:100%;margin:0;border-radius:12px}.enterprise-bootstrap-status{font-size:12px;margin:8px 0}.enterprise-bootstrap button{font:inherit;color:var(--enterprise-brand);background:transparent;border:0;cursor:pointer;min-height:32px}[hidden]{display:none!important}@media(max-width:768px){.enterprise-bootstrap-nav{display:none}}</style>`,
    body: `<div class="enterprise-bootstrap" data-enterprise-bootstrap aria-label="${html(common.loading)}"><aside class="enterprise-bootstrap-nav" aria-hidden="true"><div class="enterprise-bootstrap-line"></div><div class="enterprise-bootstrap-line"></div><div class="enterprise-bootstrap-line"></div><div class="enterprise-bootstrap-line"></div></aside><main class="enterprise-bootstrap-main"><div class="enterprise-bootstrap-header"></div><div class="enterprise-bootstrap-space"></div><div class="enterprise-bootstrap-input"><div class="enterprise-bootstrap-line" id="enterprise-bootstrap-progress"></div><p id="enterprise-bootstrap-status" role="status" class="enterprise-bootstrap-status"></p><div data-testid="enterprise-bootstrap-error" hidden><button data-testid="enterprise-bootstrap-retry" type="button">${html(common.retry)}</button></div></div></main></div><script nonce="${nonce}" data-enterprise-bootstrap-shell>${monitor}</script>`,
  };
}

export function enterpriseReadinessPage(acceptLanguage: string, nonce: string, brand: ReadinessBrand | null): string {
  const locale = localeFor(acceptLanguage);
  const { common } = locales[locale];
  const workspace: ReadinessMessages = locales[locale].workspace;
  const product = productName(brand);
  const color = brandColor(brand);
  const icon = favicon(brand, product, color);
  const copy = json({
    failed: workspace.status.preparationFailed,
    forbidden: workspace.status.capabilityForbidden,
    noModel: workspace.errors.noModel || enWorkspace.errors.noModel,
    unavailable: workspace.status.environmentUnavailable,
    recovering: workspace.status.connectionRecovering,
    expired: workspace.status.identityExpired,
    queued: workspace.status.preparationQueued,
    starting: workspace.status.preparationStarting,
    ready: workspace.status.preparationReady,
    timedOut: workspace.status.preparationTimedOut,
    elapsed: workspace.status.preparationElapsed,
  });
  const script = `const copy=${copy};const status=document.getElementById('status');const timing=document.getElementById('timing');const progress=document.getElementById('progress');const failure=document.getElementById('failure');const reason=document.getElementById('reason');const trace=document.getElementById('trace');const retry=document.getElementById('retry');let running=false;let navigating=false;let latest={trace:[]};const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));const seconds=ms=>new Intl.NumberFormat(${json(locale)},{maximumFractionDigits:1}).format(ms/1000);function render(data){latest=data;const phase=data.phase==='starting'?'starting':data.phase==='ready'?'ready':'queued';status.textContent=copy[phase];timing.textContent=copy.elapsed.replace('{{seconds}}',seconds(data.timings?.totalMs||0));const rows=[];if(data.traceId)rows.push('traceId='+data.traceId);if(Array.isArray(data.trace))rows.push(...data.trace.map(item=>item.phase+' +'+seconds(item.atMs||0)+'s'));if(data.error)rows.push('error='+data.error);trace.textContent=rows.join('\\n');}function showFailure(data,message){progress.hidden=true;failure.hidden=false;reason.textContent=message;render(data);status.textContent=copy.failed;}function showTransient(data,message){progress.hidden=false;failure.hidden=false;reason.textContent=message;render(data);}async function prepare(forceRetry=false){if(running)return;running=true;retry.disabled=true;failure.hidden=true;progress.hidden=false;if(forceRetry){latest={trace:[]};trace.textContent='';reason.textContent='';timing.textContent='';status.textContent=copy.queued;}const startedAt=Date.now();const deadline=startedAt+180000;let networkFailures=0;try{while(Date.now()<deadline){try{const requestBudget=Math.max(1,Math.min(10000,deadline-Date.now()));const response=await fetch('/enterprise/ready'+(forceRetry?'?retry=1':''),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(requestBudget)});forceRetry=false;failure.hidden=true;progress.hidden=false;if(response.status===401){navigating=true;location.replace('/enterprise/login');return;}const data=await response.json();networkFailures=0;render(data);if(response.ok&&data.ready){navigating=true;status.textContent=copy.ready;location.replace('/'+(location.hash||''));return;}if(data.phase==='failed'){const message=data.error==='DEFAULT_MODEL_UNAVAILABLE'?copy.noModel:response.status===403?copy.forbidden:data.error==='AUTHENTICATION_REQUIRED'?copy.expired:copy.unavailable;showFailure(data,message);return;}}catch{networkFailures+=1;const elapsed=Date.now()-startedAt;if(Date.now()>=deadline)break;showTransient({...latest,phase:latest.phase==='starting'?'starting':'queued',error:'CONNECTION_UNAVAILABLE',timings:{totalMs:elapsed,phaseMs:elapsed},trace:[...(latest.trace||[]).filter(item=>item.phase!=='CONNECTION_UNAVAILABLE'),{phase:'CONNECTION_UNAVAILABLE',atMs:elapsed}]},copy.recovering);const backoff=Math.min(5000,1000*2**Math.min(networkFailures-1,3));await delay(Math.min(backoff,Math.max(0,deadline-Date.now())));continue;}await delay(Math.min(1000,Math.max(0,deadline-Date.now())));}const elapsed=Date.now()-startedAt;showFailure({...latest,phase:'failed',error:'PREPARATION_TIMEOUT',timings:{totalMs:elapsed,phaseMs:elapsed},trace:[...(latest.trace||[]),{phase:'PREPARATION_TIMEOUT',atMs:elapsed}]},copy.timedOut);}finally{running=false;retry.disabled=false;if(navigating)return;}}retry.addEventListener('click',()=>prepare(true));prepare();`;
  return `<!doctype html><html lang="${locale}"${locale === 'fa-IR' ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${html(product)} · ${html(workspace.status.preparing)}</title><link rel="icon" href="${icon}"><style nonce="${nonce}">:root{--brand:${color};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans",sans-serif;color:#1a2b42;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px}main{width:min(100%,560px);background:#fff;padding:clamp(28px,6vw,48px);border-radius:20px;box-shadow:0 24px 70px -32px rgba(18,36,65,.36)}.brand{display:flex;align-items:center;gap:12px;margin-bottom:34px;color:#52647c;font-size:14px;font-weight:650}.brand img,.brand-mark{width:44px;height:44px;object-fit:contain;border-radius:11px}.brand-mark{display:grid;place-items:center;background:var(--brand);color:#fff;font-size:23px;font-weight:700}h1{margin:0 0 12px;font-size:clamp(27px,5vw,34px);line-height:1.25}#status{margin:0;color:#52647c;line-height:1.7}#timing{min-height:24px;margin:18px 0 0;color:#667085;font-variant-numeric:tabular-nums}progress{width:100%;height:6px;margin:28px 0 8px;accent-color:var(--brand)}#failure{margin-top:24px;padding:16px;border-radius:12px;background:#fff4f2;color:#8a1c1c;line-height:1.6}details{margin-top:14px;color:#52647c;font-size:13px}summary{cursor:pointer}pre{overflow:auto;white-space:pre-wrap;word-break:break-word}button{min-height:44px;margin-top:20px;padding:10px 22px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:700;cursor:pointer}button:disabled{cursor:wait;opacity:.62}[hidden]{display:none!important}@media(max-width:600px){body{display:block;padding:0;background:#fff}main{min-height:100dvh;border-radius:0;box-shadow:none}}</style></head><body><main data-enterprise-readiness><div class="brand">${brandVisual(brand, product)}<span>${html(product)}</span></div><h1>${html(workspace.status.preparing)}</h1><p id="status" role="status">${html(workspace.status.preparationQueued)}</p><progress id="progress"></progress><p id="timing"></p><section id="failure" hidden><div id="reason"></div><details><summary>${html(workspace.status.preparationTechnicalDetails)}</summary><pre id="trace"></pre></details><button id="retry" type="button">${html(common.retry)}</button></section></main><script nonce="${nonce}">${script}</script></body></html>`;
}
