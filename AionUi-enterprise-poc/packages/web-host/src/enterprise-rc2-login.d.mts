import type { EnterpriseGatewayOptions } from './enterprise-gateway.js';
export type Rc2GatewayClient = {
  me(): Promise<{ userId: string }>;
  availableModels(): Promise<Array<{ id: string; code: string; name: string; streaming: boolean }>>;
  relayModel(modelId: string, raw: string, signal: AbortSignal): Promise<Response>;
  resources(type: string): Promise<unknown>;
  authorizedResource(id: string, type: string): Promise<unknown>;
  readyMcpConnection(resourceId: string): Promise<{ id: string }>;
  authorizedMcpConnection(id: string, resourceId: string): Promise<unknown>;
  relayMcp(connectionId: string, raw: string, headers: Record<string, unknown>, signal: AbortSignal): Promise<Response>;
};
export type Rc2GatewayLogin = Awaited<ReturnType<EnterpriseGatewayOptions['login']>> & { client: Rc2GatewayClient };
export function createRc2GatewayPublicBrand(baseUrl: string, origin: string): () => Promise<unknown>;
export function createRc2GatewayLogin(baseUrl: string, origin: string):
  (username: string, password: string) => Promise<Rc2GatewayLogin>;
export function createRc2GatewayResume(baseUrl: string, origin: string):
  (cookie: string) => Promise<Rc2GatewayLogin>;
