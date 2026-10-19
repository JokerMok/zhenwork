# ADR-002 PostgreSQL 和服务端登录会话

状态：ACCEPTED R2。PostgreSQL 与迁移原则 KEEP；原自建密码、Cookie 和 token 协议 SUPERSEDE。正式采用 Better Auth 1.7.5，R1 认证 12/12 通过。关闭 cookieCache，BFF 每请求查询当前 enabled/RBAC，WebSocket 定期及发帧前检查；不使用 SaaS organization/billing。库表按固定版本生成并纳入校验 migration，不能声称库默认仅存 token hash。原决定保留如下，冲突以本段和现行 04 数据模型为准。

原决定：决定：PostgreSQL 17 + node-postgres 参数化 SQL + checksum migration；opaque HttpOnly cookie + DB hash/过期/撤销，scrypt 密码；不引入重量 OIDC 平台。原因：单实例企业产品需要事务、动态撤权、原子配额和可恢复持久化；可撤销 DB 会话比无状态长 JWT 更符合禁用立即生效。保留 IdentityProvider adapter 与 external subject 映射接口，不承诺现阶段 SSO。代价：每请求查会话/权限，要以索引与负载测试约束成本。否决：users.json、内存权威、SQLite 直接沿用 Alpha、永久 bearer。迁移策略：不导入测试密码；创建全新企业/管理员，旧合成状态保留离线证据。
