import type { AxiosPromise } from '@/utils/api-types';
import request from '@/utils/request';
export interface ProviderRow { id: string; name: string; provider_type: string; base_url: string; protocol: string; enabled: boolean; version: number; timeout_seconds: number; retry_count: number; configured: boolean; secret_updated_at: string }
export interface ModelRow { id: string; provider_id: string; provider_name: string; code: string; name: string; enabled: boolean; streaming: boolean; tools: boolean; vision: boolean; context_window: number; max_output_tokens: number; version: number; verified_status: string; default_parameters: string; cost_config: string }
export interface GrantRow { id: string; subject_type: string; subject_id: string }
export interface TestRow { id: string; model_code: string; provider_id: string; request_id: string | null; status: string; latency_ms: number; error_code: string | null; created_at: string }
export const modelApi = {
 providers: (page = 1) : AxiosPromise<ProviderRow[]> => request({ url: '/ai/admin/providers', params: { page } }),
 saveProvider: (id: string | undefined, data: object) : AxiosPromise<ProviderRow> => request({ url: '/ai/admin/providers' + (id ? '/' + id : ''), method: id ? 'put' : 'post', data }),
 models: (page = 1) : AxiosPromise<ModelRow[]> => request({ url: '/ai/admin/models', params: { page } }),
 saveModel: (id: string | undefined, data: object) : AxiosPromise<ModelRow> => request({ url: '/ai/admin/models' + (id ? '/' + id : ''), method: id ? 'put' : 'post', data }),
 grants: (id: string) : AxiosPromise<GrantRow[]> => request({ url: '/ai/admin/models/' + id + '/grants' }),
 grant: (id: string, data: object) => request({ url: '/ai/admin/models/' + id + '/grants', method: 'post', data }),
 revoke: (id: string, grant: string) => request({ url: '/ai/admin/models/' + id + '/grants/' + grant, method: 'delete' }),
 tests: (id: string) : AxiosPromise<TestRow[]> => request({ url: '/ai/admin/models/' + id + '/tests' }),
 test: (id: string) : AxiosPromise<TestRow> => request({ url: '/ai/admin/models/' + id + '/tests', method: 'post', timeout: 130000 })
};
