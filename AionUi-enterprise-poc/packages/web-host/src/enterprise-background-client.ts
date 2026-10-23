import type { Rc2GatewayClient } from './enterprise-rc2-login.mjs';

export type BackgroundGrant = { id: string; jobId: string; secret: string; userId: string };

export class BackgroundGrantRevokedError extends Error {
  constructor() { super('Background grant revoked'); }
}

export async function verifyBackgroundService(baseUrl: string, serviceToken: string,
  fetchImpl: typeof fetch = fetch): Promise<void> {
  if ((new URL(baseUrl).protocol !== 'https:' && !baseUrl.startsWith('http://127.0.0.1:')) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(serviceToken)) throw new Error('Invalid background service configuration');
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/internal/rc2/background/health`, {
    headers: { Authorization: `Bearer ${serviceToken}` }, signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch((): null => null) as { code?: number; data?: { ready?: boolean } } | null;
  if (!response.ok || body?.code !== 200 || body.data?.ready !== true) {
    throw new Error('RC2 background service unavailable');
  }
}

/** Host-only RC2 client. Neither the service token nor the grant enters Core or the browser. */
export class EnterpriseBackgroundClient implements Rc2GatewayClient {
  private readonly prefix: string;

  constructor(private readonly baseUrl: string, private readonly serviceToken: string,
    private readonly grant: BackgroundGrant, private readonly fetchImpl: typeof fetch = fetch) {
    if (new URL(baseUrl).protocol !== 'https:' && !baseUrl.startsWith('http://127.0.0.1:')) {
      throw new Error('Background RC2 requires HTTPS');
    }
    if (!/^[0-9a-f-]{36}$/i.test(grant.id) || !/^cron_[A-Za-z0-9_-]{8,80}$/.test(grant.jobId) ||
        !/^[0-9a-f]{64}$/.test(grant.secret) || !/^[0-9]{1,20}$/.test(grant.userId) ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(serviceToken)) {
      throw new Error('Invalid background grant');
    }
    this.prefix = `/internal/rc2/background/grants/${grant.id}`;
  }

  private fetchRc2(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${this.prefix}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.serviceToken}`, 'X-Aion-Background-Secret': this.grant.secret,
        ...init.headers },
      signal: init.signal || AbortSignal.timeout(10_000),
    });
  }

  private async read(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchRc2(path, signal ? { signal } : {});
    const body = await response.json().catch((): null => null) as { code?: number; data?: unknown } | null;
    if ([401, 403].includes(response.status) || [401, 403].includes(body?.code ?? 0)) {
      throw new BackgroundGrantRevokedError();
    }
    if (!response.ok || body?.code !== 200) throw new Error('Background RC2 unavailable');
    return body.data;
  }

  async me(signal?: AbortSignal): Promise<{ userId: string }> {
    const result = await this.read('', signal) as { userId?: string; jobId?: string };
    if (result?.userId !== this.grant.userId || result.jobId !== this.grant.jobId)
      throw new Error('Background grant actor mismatch');
    return { userId: result.userId };
  }

  async availableModels(): Promise<Array<{ id: string; code: string; name: string; streaming: boolean }>> {
    const data = await this.read('/models/available');
    if (!Array.isArray(data)) throw new Error('Background models unavailable');
    return data.filter((model): model is { id: string; code: string; name: string; streaming: boolean } =>
      !!model && typeof model.id === 'string' && typeof model.code === 'string' &&
      typeof model.name === 'string' && model.streaming === true);
  }

  relayModel(modelId: string, raw: string, signal: AbortSignal, conversationId?: string): Promise<Response> {
    return this.fetchRc2(`/models/${encodeURIComponent(modelId)}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(conversationId ? { 'X-Aion-Conversation-Id': conversationId } : {}) }, body: raw, signal,
    });
  }

  async resources(type: string): Promise<unknown> {
    if (!['ASSISTANT', 'SKILL', 'MCP', 'KNOWLEDGE'].includes(type)) throw new Error('Invalid background resource type');
    const items = new Map<string, Record<string, unknown>>();
    for (let page = 1; page <= 100; page++) {
      const data = await this.read(`/resources?type=${type}&scope=available&page=${page}`);
      if (!Array.isArray(data)) throw new Error('Background resources unavailable');
      for (const item of data) {
        if (!item || typeof item.id !== 'string' || !item.actions?.includes('USE') ||
            !Number.isInteger(item.publishedVersion)) continue;
        items.set(item.id, { id: item.id, name: item.name, description: item.description,
          version: item.publishedVersion,
          source: item.source === 'ORGANIZATION' ? 'enterprise' : 'personal', type });
      }
      if (data.length < 30) return [...items.values()];
    }
    throw new Error('Enterprise capability catalog exceeds 3000 resources; narrow the authorized scope');
  }

  async authorizedResource(id: string, type: string): Promise<unknown> {
    const data = await this.read(`/resources/${encodeURIComponent(id)}`) as Record<string, unknown>;
    if (data?.resourceType !== type || !Array.isArray(data.actions) || !data.actions.includes('USE') ||
        data.publishedVersion !== data.version) throw new Error('Background resource unavailable');
    return data;
  }

  knowledgeSearch(baseId: string, query: string): Promise<unknown> {
    if (!/^[0-9a-f-]{36}$/i.test(baseId) || !query.trim() || query.length > 500) {
      throw new Error('Invalid background knowledge query');
    }
    return this.read(`/knowledge/${encodeURIComponent(baseId)}/search?query=${encodeURIComponent(query)}`);
  }

  private async connections(resourceId: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.read(`/mcp/connections?resourceId=${encodeURIComponent(resourceId)}`);
    if (!Array.isArray(data)) throw new Error('Background MCP connections unavailable');
    return data;
  }

  async readyMcpConnection(resourceId: string): Promise<{ id: string }> {
    const data = await this.connections(resourceId);
    const connection = data.find((item) => item.enabled === true && item.status === 'READY' && item.scope === 'ENTERPRISE') ||
      data.find((item) => item.enabled === true && item.status === 'READY');
    if (typeof connection?.id !== 'string') throw new Error('Background MCP connection unavailable');
    return { id: connection.id };
  }

  async authorizedMcpConnection(id: string, resourceId: string): Promise<unknown> {
    const connection = (await this.connections(resourceId)).find((item) => item.id === id);
    if (!connection || connection.enabled !== true || connection.status !== 'READY')
      throw new Error('Background MCP connection unavailable');
    return connection;
  }

  relayMcp(connectionId: string, raw: string, headers: Record<string, unknown>, signal: AbortSignal, conversationId?: string): Promise<Response> {
    return this.fetchRc2(`/mcp/connections/${encodeURIComponent(connectionId)}/relay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        ...(conversationId ? { 'X-Aion-Conversation-Id': conversationId } : {}),
        ...(typeof headers['mcp-session-id'] === 'string' ? { 'Mcp-Session-Id': headers['mcp-session-id'] } : {}),
        ...(typeof headers['mcp-protocol-version'] === 'string' ?
          { 'MCP-Protocol-Version': headers['mcp-protocol-version'] } : {}),
        ...(typeof headers['x-zhenwork-idempotency-key'] === 'string' ?
          { 'X-ZhenWork-Idempotency-Key': headers['x-zhenwork-idempotency-key'] } : {}) }, body: raw, signal,
    });
  }
}
