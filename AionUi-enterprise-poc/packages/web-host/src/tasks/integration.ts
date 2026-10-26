import type { EnterpriseActor } from '../enterprise-gateway.js';
export type TaskRuntime = {
  issueTaskGrant(actor: EnterpriseActor, jobId: string): Promise<void>;
  checkTaskGrant(actor: EnterpriseActor, jobId: string): Promise<boolean>;
  revokeTaskGrant(actor: EnterpriseActor, jobId: string): Promise<void>;
  bindTask(actor: EnterpriseActor, conversation: string, jobId?: string, expectedJobId?: string): void;
  taskActors(): Promise<EnterpriseActor[]>;
  trustedTaskConfirmation(actor: EnterpriseActor, confirmation: Record<string, unknown>): Promise<boolean>;
};
