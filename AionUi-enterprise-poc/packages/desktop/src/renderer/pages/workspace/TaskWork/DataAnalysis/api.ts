import { enterpriseRequest } from '../../workspaceApi';
export type Policy = {
  id: string;
  name: string;
  version: number;
  definition: {
    meaning: string;
    scope: string;
    includeNodes: string[];
    precision: number;
    duplicateRule: string;
  };
};
export type Mapping = {
  sheet: string;
  headerRow: number;
  fields: Record<string, number>;
  defaultUnit?: string;
  confirmed: boolean;
  version: number;
};
export type Dataset = {
  id: string;
  name: string;
  sourcePath: string;
  mapping: Mapping;
  period?: string;
  ruleId?: string;
  source: { sha256: string; versionId: string };
  structure: {
    meta: { encoding?: string; delimiter?: string };
    sheets: Array<{
      name: string;
      columns: string[];
      rowCount: number;
      sample: Array<{ row: number; values: string[] }>;
    }>;
  };
};
export type AnalysisSummary = {
  issueCount: number;
  id: string;
  policy: { name: string; version: number };
  createdAt: string;
  result: {
    status: string;
    rowCount: number;
    includedCount: number;
    excludedCount: number;
    invalidCount: number;
    blockerCount: number;
    summary: null | { weightKg: string; weightTon: string };
    issues: Array<{ row: number; sheet: string; code: string; field?: string; severity: string }>;
  };
  artifacts: Array<{ path: string; downloadUrl: string }>;
};
export type DataDetail = { dataset: Dataset; policies: Policy[]; analyses?: AnalysisSummary[] };
export const detail = (id: string, signal?: AbortSignal) =>
  enterpriseRequest<DataDetail>('/enterprise/data/' + id, { signal });
export const importData = (path: string, conversation?: string) =>
  enterpriseRequest<DataDetail>('/enterprise/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, conversation }),
  });
