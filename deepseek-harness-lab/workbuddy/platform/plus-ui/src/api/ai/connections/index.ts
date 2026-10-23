import request from '@/utils/request';

export type ConnectorType = 'UFEI_DASHBOARD' | 'CSWM_IOT';
export type ConnectionEnvironment = 'TEST' | 'PRODUCTION';

export interface ConnectorEnvironment {
  name: ConnectionEnvironment;
  baseUrl: string;
  production: boolean;
}

export interface ConnectorMethod {
  name: string;
  title: string;
  path: string;
  readOnly: boolean;
  inputSchema?: unknown;
  outputSchema?: unknown;
  returnFields?: Record<string, string>;
  unit?: string;
  timeSemantics?: string;
  environmentNotes?: string;
  safeCause?: string;
  available?: boolean;
  status?: 'AVAILABLE' | 'UNAVAILABLE' | string;
  unavailableReason?: string;
}

export interface ConnectorCatalog {
  type: ConnectorType;
  displayName: string;
  environments: ConnectorEnvironment[];
  methods: ConnectorMethod[];
}

export interface VerifiedIdentity {
  enterpriseId?: string;
  name?: string;
  creditCode?: string;
  businessUnitMatched?: boolean;
  verifiedAt?: string;
  matched?: boolean;
}

export interface ExternalConnection {
  id: string;
  resourceId?: string;
  assistantId?: string;
  expertConnectionIds?: string[];
  expertResourceIds?: string[];
  type: ConnectorType;
  name: string;
  businessUnit: string;
  environment: ConnectionEnvironment;
  baseUrl: string;
  credentialConfigured: boolean;
  configurationConsistent?: boolean;
  expectedBaseUrl?: string;
  adapterStatus?: string;
  validationResult?: {
    valid?: boolean;
    category?: string;
    message?: string;
    code?: string;
    businessCode?: string;
    method?: string;
    checkedAt?: string;
  };
  verifiedIdentity?: VerifiedIdentity | boolean;
  testedStatus: string;
  testedAt?: string;
  lastError?: string;
  enabled: boolean;
  allowedMethods: string[];
  version: number;
  updatedAt?: string;
}

export interface ConnectionInput {
  type: ConnectorType;
  name: string;
  businessUnit: string;
  environment: ConnectionEnvironment;
  baseUrl: string;
  credential?: string;
  clearCredential?: boolean;
  allowedMethods: string[];
  enabled: boolean;
  expectedVersion?: number;
}

export interface ConnectionCall {
  id: string;
  actorUserId?: string;
  businessUnit?: string;
  method: string;
  status?: string;
  errorCode?: string;
  durationMs?: number;
  connectionVersion?: number;
  createdAt: string;
}

async function data<T>(config: Parameters<typeof request>[0]): Promise<T> {
  return (await request(config)).data;
}

export const connectionApi = {
  catalog: () => data<ConnectorCatalog[]>({ url: '/ai/external/connectors', method: 'get' }),
  list: () => data<ExternalConnection[]>({ url: '/ai/external/connections', method: 'get' }),
  create: (input: ConnectionInput) =>
    data<ExternalConnection>({ url: '/ai/external/connections', method: 'post', data: input }),
  update: (id: string, input: ConnectionInput) =>
    data<ExternalConnection>({ url: `/ai/external/connections/${id}`, method: 'put', data: input }),
  verify: (id: string, expectedVersion: number) =>
    data<ExternalConnection>({
      url: `/ai/external/connections/${id}/verify`,
      method: 'post',
      data: { expectedVersion }
    }),
  calls: (id: string, page: number) =>
    data<ConnectionCall[]>({ url: `/ai/external/connections/${id}/calls`, method: 'get', params: { page } }),
  expert: (id: string, expectedVersion: number, connectionIds: string[]) =>
    data<Record<string, unknown>>({
      url: `/ai/external/connections/${id}/expert`,
      method: 'post',
      data: { expectedVersion, connectionIds }
    })
};
