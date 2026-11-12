import type { UserVO } from '@/api/system/user/types';
import type { PageResult } from '@/api/types';
import type { AxiosPromise } from '@/utils/api-types';
import request from '@/utils/request';
export interface ProviderRow { id: string; name: string; provider_type: string; base_url: string; protocol: string; enabled: boolean; version: number; timeout_seconds: number; retry_count: number; configured: boolean; secret_updated_at: string }
export interface ModelRow { id: string; provider_id: string; provider_name: string; provider_enabled: boolean; code: string; name: string; enabled: boolean; streaming: boolean; tools: boolean; vision: boolean; context_window: number; max_output_tokens: number; version: number; verified_status: string; default_parameters: string; cost_config: string }
export interface GrantRow { id: string; subject_type: string; subject_id: string; name?: string }
export interface TestRow { id: string; model_code: string; provider_id: string; request_id: string | null; status: string; latency_ms: number; error_code: string | null; created_at: string }
export type EmployeeModelStatus =
  | 'AVAILABLE' | 'MODEL_DISABLED' | 'PROVIDER_DISABLED' | 'NO_GRANT'
  | 'EMPLOYEE_INACTIVE' | 'PASSWORD_CHANGE_REQUIRED' | 'EMPLOYEE_PERMISSION_REQUIRED'
  | 'STREAMING_REQUIRED' | 'OUTSIDE_CATALOG';

export interface EmployeeModelRow {
  id: string;
  name: string;
  code: string;
  status: EmployeeModelStatus;
  sources: { type: string; label: string | null }[];
}

export async function searchModelEmployees(query: string, signal?: AbortSignal, enabledOnly = false) {
  const search = (field: 'userName' | 'nickName'): AxiosPromise<PageResult<UserVO>> =>
    request({ url: '/system/user/list', params: { pageNum: 1, pageSize: 30, [field]: query, ...(enabledOnly ? { status: '0' } : {}) }, signal });
  const pages = await Promise.all([search('userName'), search('nickName')]);
  const options = new Map<string, { id: string; name: string }>();
  for (const { data } of pages) {
    for (const user of data.rows) {
      const id = String(user.userId);
      options.set(id, { id, name: [user.nickName, user.userName, (user.deptName || user.dept?.deptName)].filter(Boolean).join(' · ') });
    }
  }
  return [...options.values()];
}

export const modelApi = {
 providers: (page = 1) : AxiosPromise<ProviderRow[]> => request({ url: '/ai/admin/providers', params: { page } }),
 saveProvider: (id: string | undefined, data: object) : AxiosPromise<ProviderRow> => request({ url: '/ai/admin/providers' + (id ? '/' + id : ''), method: id ? 'put' : 'post', data }),
 models: (page = 1) : AxiosPromise<ModelRow[]> => request({ url: '/ai/admin/models', params: { page } }),
 saveModel: (id: string | undefined, data: object) : AxiosPromise<ModelRow> => request({ url: '/ai/admin/models' + (id ? '/' + id : ''), method: id ? 'put' : 'post', data }),
 employeeModels: (userId: string, modelId: string | undefined, page: number, signal: AbortSignal)
   : AxiosPromise<{ items: EmployeeModelRow[]; hasMore: boolean }> =>
   request({ url: '/ai/admin/models/employee-access', params: { userId, modelId, page }, signal }),
 grants: (id: string, signal?: AbortSignal) : AxiosPromise<GrantRow[]> => request({ url: '/ai/admin/models/' + id + '/grants', signal }),
 grant: (id: string, data: object) => request({ url: '/ai/admin/models/' + id + '/grants', method: 'post', data }),
 revoke: (id: string, grant: string) => request({ url: '/ai/admin/models/' + id + '/grants/' + grant, method: 'delete' }),
 tests: (id: string, signal?: AbortSignal) : AxiosPromise<TestRow[]> => request({ url: '/ai/admin/models/' + id + '/tests', signal }),
 test: (id: string) : AxiosPromise<TestRow> => request({ url: '/ai/admin/models/' + id + '/tests', method: 'post', timeout: 130000 })
};
