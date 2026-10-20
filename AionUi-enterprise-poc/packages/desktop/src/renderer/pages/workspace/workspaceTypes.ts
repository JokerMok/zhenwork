export type WebConversationTask = {
  key: string;
  id: string;
  source: 'enterprise_web';
  name: string;
  modified_at: number | null;
  status: string | null;
  pinned: boolean;
};

export type EnterpriseFileVersion = {
  id: string;
  createdAt: string;
  byteSize: number;
  sha256: string;
};

export type EnterpriseFile = {
  path: string;
  name: string;
  byteSize: number;
  modifiedAt: string;
  kind: 'task' | 'personal' | 'shared' | 'generated' | string;
  versions: EnterpriseFileVersion[];
};

export type ResourceScope = 'mine' | 'shared';

export type WorkspaceResource = {
  id: string;
  resourceType: 'ASSISTANT' | 'KNOWLEDGE' | 'SKILL' | 'MCP' | 'TOOL';
  ownerType: 'USER' | 'ENTERPRISE';
  ownerUserId?: string | null;
  visibility: string;
  lifecycleState: string;
  enabled: boolean;
  name: string;
  description?: string;
  version: number;
  publishedVersion?: number | null;
  securityDisabled?: boolean;
  reviewState?: string;
  updatedAt: string;
  actions: string[];
  config?: Record<string, unknown>;
};

export type KnowledgeDocument = {
  id: string;
  title: string;
  latest_version: number;
  indexed_version?: number | null;
  version: number;
  status: string;
  file_id: string;
  updated_at: string;
  mediaType?: string;
  extractionMethod?: string;
  extractionMetadata?: Record<string, unknown>;
};

export type KnowledgeCitation = {
  reference: string;
  documentId: string;
  version: number;
  chunkIndex: number;
  locationType?: string;
  locationLabel?: string;
  lineStart?: number;
  lineEnd?: number;
  content: string;
  title: string;
  fileId: string;
  sha256: string;
  sourceUrl?: string;
  downloadUrl?: string;
};

export type KnowledgeSearchResponse = {
  searchId: string;
  retrievalMode: 'POSTGRES_LEXICAL';
  citations: KnowledgeCitation[];
};

export type KnowledgeJob = {
  id: string;
  document_id: string;
  version: number;
  status: string;
  error_code?: string | null;
  errorCode?: string | null;
};

export type WorkspaceMemory = {
  id: string;
  scope: 'personal' | 'project';
  projectId?: string | null;
  content: string;
  updatedAt: string;
};
