-- Separate safe validation evidence from adapter readiness and user authorization.
ALTER TABLE ai_external_connection ADD COLUMN validation_result JSONB NOT NULL DEFAULT '{}'::jsonb;
-- These failures were preflight adapter checks, not credential authentication attempts.
UPDATE ai_external_connection SET tested_status='NOT_TESTED',last_error=NULL,
 validation_result='{"category":"ADAPTER_NOT_READY","message":"此前查询能力合同尚未就绪，未执行凭据鉴权；请重新验证"}'::jsonb
 WHERE last_error IN ('NoVerifiedConnectorMethods','ConnectorContractUnverified','CONNECTOR_CONTRACT_UNVERIFIED');
UPDATE ai_mcp_connection c SET status='NOT_TESTED',last_error=NULL
 FROM ai_external_connection e WHERE c.id=e.id AND e.validation_result->>'category'='ADAPTER_NOT_READY';
