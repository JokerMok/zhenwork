const PROVIDER_ID = 'rc2-enterprise-model';

function coreBase(target) {
  if (typeof target === 'number') return `http://127.0.0.1:${target}`;
  const host = target?.host || '127.0.0.1';
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) {
    throw new Error('Enterprise Core address invalid');
  }
  const parts = host.split('.').map(Number);
  if (!Number.isInteger(target?.port) || target.port < 1 || target.port > 65535 ||
      parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
      !((parts[0] === 127 && parts[1] === 0 && parts[2] === 0 && parts[3] === 1) ||
        parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168))) throw new Error('Enterprise Core address invalid');
  return `http://${host}:${target.port}`;
}

function proxyHost(value) {
  const host = value || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'model-gateway') throw new Error('Enterprise proxy address invalid');
  return host;
}

function isManagedProvider(provider) {
  if (provider?.id !== PROVIDER_ID || provider.platform !== 'custom') return false;
  try {
    const url = new URL(provider.base_url);
    return url.protocol === 'http:' && ['127.0.0.1', 'model-gateway'].includes(url.hostname) &&
      !url.username && !url.password;
  } catch { return false; }
}

async function listedProviders(corePort, localToken, fetchImpl) {
  const headers = { 'x-aion-enterprise-local-token': localToken, 'Content-Type': 'application/json' };
  const response = await fetchImpl(`${coreBase(corePort)}/api/providers`, { headers });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true || !Array.isArray(body.data)) throw new Error('AionCore provider list failed');
  return body.data;
}

export async function removeEnterpriseModelProvider(corePort, localToken, fetchImpl = fetch) {
  const provider = (await listedProviders(corePort, localToken, fetchImpl)).find((item) => item.id === PROVIDER_ID);
  if (!provider) return false;
  if (!isManagedProvider(provider)) throw new Error('Personal provider conflicts with reserved enterprise provider');
  const response = await fetchImpl(`${coreBase(corePort)}/api/providers/${PROVIDER_ID}`, {
    method: 'DELETE', headers: { 'x-aion-enterprise-local-token': localToken },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) throw new Error('AionCore enterprise provider removal failed');
  return true;
}

// AionCore stores only a rotating loopback capability, never the enterprise
// provider key. The provider is refreshed before the worker opens its UI.
export async function syncEnterpriseModelProvider(corePort, localToken, config = process.env, fetchImpl = fetch) {
  const { AION_ENTERPRISE_MODEL_PROXY_PORT: proxyPort, AION_ENTERPRISE_MODEL_PROXY_KEY: proxyKey,
    AION_ENTERPRISE_MODEL_CODE: code, AION_ENTERPRISE_MODEL_NAME: name,
    AION_ENTERPRISE_MODEL_PROXY_HOST: requestedProxyHost } = config;
  if (!/^\d+$/.test(proxyPort || '') || !proxyKey || !code || !name) throw new Error('Enterprise model configuration missing');
  const host = proxyHost(requestedProxyHost);
  const base = coreBase(corePort);
  const headers = { 'x-aion-enterprise-local-token': localToken, 'Content-Type': 'application/json' };
  const provider = (await listedProviders(corePort, localToken, fetchImpl)).find((item) => item.id === PROVIDER_ID);
  if (provider && !isManagedProvider(provider)) throw new Error('Personal provider conflicts with reserved enterprise provider');
  const exists = Boolean(provider);
  const body = {
    ...(exists ? {} : { id: PROVIDER_ID }), platform: 'custom', name,
    base_url: `http://${host}:${proxyPort}`, api_key: proxyKey, models: config.AION_ENTERPRISE_MODELS_JSON ? JSON.parse(config.AION_ENTERPRISE_MODELS_JSON).map((item) => item.code) : [code], enabled: true,
    model_protocols: Object.fromEntries((config.AION_ENTERPRISE_MODELS_JSON ? JSON.parse(config.AION_ENTERPRISE_MODELS_JSON) : [{code}]).map((item) => [item.code, 'openai'])),
    model_settings: Object.fromEntries((config.AION_ENTERPRISE_MODELS_JSON ? JSON.parse(config.AION_ENTERPRISE_MODELS_JSON) : [{code}]).map((item) => [item.code, { openai_api_mode: 'chat_completions' }])),
    capabilities: [{ type: 'text' }], is_full_url: false,
  };
  const saved = await fetchImpl(`${base}/api/providers${exists ? `/${PROVIDER_ID}` : ''}`, {
    method: exists ? 'PUT' : 'POST', headers, body: JSON.stringify(body),
  });
  const result = await saved.json().catch(() => null);
  if (!saved.ok || result?.success !== true || result?.data?.id !== PROVIDER_ID) {
    throw new Error('AionCore enterprise provider sync failed');
  }
  return { providerId: PROVIDER_ID, model: code };
}
