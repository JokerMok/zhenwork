// RC2 is the only identity provider. The Sa-Token cookie never enters renderer state.
import { normalizeServer } from './serverConfig.mjs';
export class Rc2ConnectionError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function assertLoadedResourceVersion(resource, loadedVersion) {
  if (!Number.isInteger(loadedVersion) || resource?.version !== loadedVersion) {
    throw new Error('Enterprise resource version changed');
  }
}

const brandAssetId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeEnterpriseBrand(value) {
  if (!value || typeof value !== 'object') return null;
  const text = (key, max) => (typeof value[key] === 'string' ? value[key].trim().slice(0, max) : '');
  const productName = text('productName', 80);
  if (!productName) return null;
  return {
    productName,
    companyName: text('companyName', 100),
    loginTitle: text('loginTitle', 100),
    loginSubtitle: text('loginSubtitle', 300),
    primaryColor: /^#[0-9a-f]{6}$/i.test(value.primaryColor) ? value.primaryColor : '',
    logoAssetId: brandAssetId.test(value.logoAssetId || '') ? value.logoAssetId : '',
    version: Number.isSafeInteger(value.version) ? value.version : 0,
  };
}

function transportError(error) {
  const code = String(error?.cause?.code || error?.code || '');
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i.test(code)) {
    return new Rc2ConnectionError('CERTIFICATE');
  }
  return new Rc2ConnectionError('CONNECTION');
}

export class Rc2Client {
  constructor(baseUrl, origin = new URL(baseUrl).origin, fetchImpl = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.origin = origin;
    this.fetchImpl = fetchImpl;
    this.cookie = '';
    this.clientId = '';
    this.serverId = '';
  }

  async request(path, options = {}) {
    const headers = { ...options.headers };
    if (this.clientId) headers.clientid = this.clientId;
    if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase()))
      headers.Origin = this.origin;
    if (this.cookie) headers.Cookie = this.cookie;
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        headers,
        signal: options.signal || AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw transportError(error);
    }
    const body = await response.json().catch(() => null);
    return { response, body };
  }

  async bootstrap() {
    const { response, body } = await this.request('/ai/bootstrap');
    if (response.status === 404) throw new Rc2ConnectionError('VERSION');
    if (!response.ok || body?.code !== 200) throw new Rc2ConnectionError('CONNECTION');
    if (
      body?.data?.protocolVersion !== 2 ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(body?.data?.serverId || '') ||
      !body?.data?.clientId
    ) {
      throw new Rc2ConnectionError('VERSION');
    }
    this.clientId = body.data.clientId;
    this.serverId = body.data.serverId;
    if (body.data.requiredOrigin !== undefined) {
      try {
        this.origin = normalizeServer(this.baseUrl, body.data.requiredOrigin).origin;
      } catch {
        throw new Rc2ConnectionError('VERSION');
      }
    }
    return body.data;
  }

  async branding() {
    const { response, body } = await this.request('/ai/brand');
    if (!response.ok || body?.code !== 200) throw new Rc2ConnectionError('CONNECTION');
    const brand = normalizeEnterpriseBrand(body.data);
    if (!brand) return null;
    if (!brand.logoAssetId) return brand;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/ai/brand/assets/${brand.logoAssetId}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (
        !response.ok ||
        !response.headers.get('content-type')?.startsWith('image/png') ||
        Number(response.headers.get('content-length') || 0) > 2 * 1024 * 1024
      )
        return brand;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return brand;
      return { ...brand, logoDataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
    } catch {
      return brand;
    }
  }

  async login({ username, password, code = undefined, uuid = undefined }) {
    if (!this.clientId) await this.bootstrap();
    const { clientId } = this;
    const { response, body } = await this.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, grantType: 'password', username, password, ...(code ? { code, uuid } : {}) }),
    });
    if (!response.ok || body?.code !== 200) {
      const reason = String(body?.msg || body?.message || '');
      throw new Rc2ConnectionError(reason.includes('OriginDenied') ? 'ORIGIN' : 'CREDENTIALS');
    }
    // access_token is intentionally the non-secret marker "cookie-session" in RC2.
    const setCookie = response.headers.getSetCookie?.().find((value) => value.startsWith('__Host-workspace-rc2='));
    if (!setCookie) throw new Rc2ConnectionError('VERSION');
    this.cookie = setCookie.split(';', 1)[0];
    try {
      const actor = await this.me();
      this.userId = actor.userId;
      return { ...actor, serverId: this.serverId };
    } catch (error) {
      await this.logout().catch(() => {
        this.cookie = '';
      });
      throw error;
    }
  }

  async me() {
    if (!this.cookie) throw new Error('No RC2 session');
    const { response, body } = await this.request('/ai/me');
    if (!response.ok || body?.code !== 200 || !/^[0-9]+$/.test(String(body?.data?.userId ?? ''))) {
      throw new Error('RC2 session revoked or user disabled');
    }
    return { userId: String(body.data.userId), mustChangePassword: body.data.mustChangePassword === true };
  }

  async availableModels() {
    if (!this.cookie) throw new Error('No RC2 session');
    const { response, body } = await this.request('/ai/models/available');
    if (!response.ok || body?.code !== 200 || !Array.isArray(body.data)) throw new Error('RC2 models unavailable');
    return body.data.filter(
      (model) =>
        typeof model.id === 'string' &&
        typeof model.code === 'string' &&
        typeof model.name === 'string' &&
        model.streaming === true
    );
  }

  async authorizedResource(id, type) {
    if (!this.cookie) throw new Error('No RC2 session');
    const { response, body } = await this.request(`/ai/resources/${encodeURIComponent(id)}`);
    if (
      !response.ok ||
      body?.code !== 200 ||
      body?.data?.resourceType !== type ||
      !body.data.actions?.includes('USE') ||
      body.data.publishedVersion !== body.data.version
    ) {
      throw new Error('RC2 resource unavailable');
    }
    return body.data;
  }

  async authorizedMcpConnection(id, resourceId) {
    const { response, body } = await this.request(`/ai/mcp/connections?resourceId=${encodeURIComponent(resourceId)}`);
    const connection = body?.data?.find((item) => item.id === id);
    if (!response.ok || body?.code !== 200 || !connection?.enabled || connection.status !== 'READY') {
      throw new Error('RC2 MCP connection unavailable');
    }
    return connection;
  }

  async readyMcpConnection(resourceId) {
    const { response, body } = await this.request(`/ai/mcp/connections?resourceId=${encodeURIComponent(resourceId)}`);
    if (!response.ok || body?.code !== 200 || !Array.isArray(body.data)) {
      throw new Error('RC2 MCP connections unavailable');
    }
    const connection =
      body.data.find((item) => item.enabled && item.status === 'READY' && item.scope === 'ENTERPRISE') ||
      body.data.find((item) => item.enabled && item.status === 'READY');
    if (!connection?.id) throw new Error('RC2 MCP connection unavailable');
    return connection;
  }

  async resources(type) {
    if (!['ASSISTANT', 'SKILL', 'MCP', 'KNOWLEDGE'].includes(type)) throw new Error('Invalid resource type');
    const items = new Map();
    for (const scope of ['mine', 'shared', 'public']) {
      for (let page = 1; page <= 10; page++) {
        const { response, body } = await this.request(`/ai/resources?type=${type}&scope=${scope}&page=${page}`);
        if (!response.ok || body?.code !== 200 || !Array.isArray(body.data))
          throw new Error('RC2 resources unavailable');
        for (const item of body.data)
          if (item?.actions?.includes('USE') && item.publishedVersion === item.version) {
            items.set(item.id, {
              id: item.id,
              name: item.name,
              description: item.description,
              version: item.version,
              source:
                item.ownerType === 'ENTERPRISE'
                  ? 'enterprise'
                  : item.ownerUserId === this.userId
                    ? 'personal'
                    : 'shared',
              type,
            });
          }
        if (body.data.length < 30) break;
      }
    }
    return [...items.values()];
  }

  async knowledgeDocuments(baseId) {
    await this.authorizedResource(baseId, 'KNOWLEDGE');
    const { response, body } = await this.request(`/ai/knowledge/${encodeURIComponent(baseId)}/documents`);
    if (!response.ok || body?.code !== 200 || !Array.isArray(body.data)) throw new Error('RC2 documents unavailable');
    return body.data.map((item) => ({ id: item.id, title: item.title, version: item.version, fileId: item.file_id }));
  }

  async authorizedDocument(baseId, documentId, version) {
    const documents = await this.knowledgeDocuments(baseId);
    if (!documents.some((item) => item.id === documentId && item.version === version)) {
      throw new Error('RC2 document unavailable');
    }
  }

  async knowledgeFile(documentId, version) {
    if (!/^[0-9a-f-]{36}$/i.test(documentId) || !Number.isInteger(version) || version < 1)
      throw new Error('Invalid document');
    const { response, body } = await this.request(`/ai/knowledge/documents/${documentId}/versions/${version}`);
    if (
      !response.ok ||
      body?.code !== 200 ||
      body.data?.documentId !== documentId ||
      body.data?.version !== version ||
      !/^[0-9a-f-]{36}$/i.test(body.data?.fileId || '')
    ) {
      throw new Error('RC2 document unavailable');
    }
    const result = await this.fetchImpl(`${this.baseUrl}/ai/files/${body.data.fileId}/download`, {
      headers: { Cookie: this.cookie, clientid: this.clientId },
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw new Error('RC2 file access denied');
    const length = Number(result.headers.get('content-length') || 0);
    if (length > 2 * 1024 * 1024) throw new Error('Enterprise file too large');
    const bytes = Buffer.from(await result.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) throw new Error('Enterprise file too large');
    return { bytes, filename: String(body.data.filename || 'document.txt'), fileId: body.data.fileId };
  }

  async knowledgePreview(documentId, version) {
    if (!/^[0-9a-f-]{36}$/i.test(documentId) || !Number.isInteger(version) || version < 1)
      throw new Error('Invalid document');
    const { response, body } = await this.request(`/ai/knowledge/documents/${documentId}/versions/${version}`);
    if (!response.ok || body?.code !== 200 || body.data?.documentId !== documentId || body.data?.version !== version)
      throw new Error('RC2 document unavailable');
    return { filename: body.data.filename, content: body.data.content, version };
  }

  relayMcp(connectionId, raw, headers, signal) {
    if (!this.cookie || !this.clientId) throw new Error('No RC2 session');
    return this.fetchImpl(`${this.baseUrl}/ai/mcp/connections/${encodeURIComponent(connectionId)}/relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.origin,
        Cookie: this.cookie,
        clientid: this.clientId,
        ...(headers['mcp-session-id'] ? { 'Mcp-Session-Id': headers['mcp-session-id'] } : {}),
        ...(headers['mcp-protocol-version'] ? { 'MCP-Protocol-Version': headers['mcp-protocol-version'] } : {}),
      },
      body: raw,
      signal,
    });
  }

  relayModel(modelId, raw, signal) {
    if (!this.cookie || !this.clientId) throw new Error('No RC2 session');
    return this.fetchImpl(`${this.baseUrl}/ai/model-relay/${encodeURIComponent(modelId)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: this.origin,
        Cookie: this.cookie,
        clientid: this.clientId,
      },
      body: raw,
      signal,
    });
  }

  async logout() {
    try {
      if (this.cookie) {
        const { response, body } = await this.request('/auth/logout', { method: 'POST' });
        if (!response.ok || body?.code !== 200) throw new Error('RC2 logout failed');
      }
    } finally {
      this.cookie = '';
      this.userId = '';
    }
  }
}
