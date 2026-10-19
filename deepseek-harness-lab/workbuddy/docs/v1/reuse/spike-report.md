# R1 三个实际集成 Spike

2026-09-18；实现位于 `spikes/foundation`。测试环境为 macOS ARM64、Node 24.19.0、Chrome headless、PostgreSQL 17 Docker。没有把本地浏览器上下文当作独立真实用户/设备远程验收。

| Spike | 实际链路和结果 | Evidence |
|---|---|---|
| A | assistant-ui → 自定义 external-store adapter → 同源 Cookie BFF relay → 未修改 Alpha BFF WebSocket → 固定 Harness → Ark 豆包。浏览器生命周期 11/11：chat/stream/resume/file tool/审批允许与拒绝/cancel/retry/reload reconnect/cross-user/disabled WS；244 个状态帧中 86 个包含增量文本 | browser-chat-e2e.json、gateway/gateway.jsonl、employee-chat-lifecycle.png、approval-pending.png |
| B | Better Auth 1.7.5 → PostgreSQL 17 → BFF identity。12/12：登录/HttpOnly+SameSite、错误密码、员工拒绝 admin API、真实员工表、CSRF、关闭公开注册、logout 后旧 Cookie 拒绝、DB expiry/revoke、禁用、品牌权限 | auth-results.json、better-auth-migration.sql |
| C | 官方 cleanup 后 dashboard Sidebar/Base UI/TanStack 表格 → Workbuddy API → PostgreSQL BrandConfig。真实登录/导航/用户过滤/品牌保存、刷新持久、退出登录通过；无浏览器异常或外部服务请求 | browser-smoke.json、admin-users.png、admin-brand.png |

## 发现与修正

1. 初始快速认证用例触发 Better Auth 默认登录限流，保存为 `auth-results-initial-rate-limit.json`。测试改为遵循 Retry-After，未降低限流，重跑 12/12。
2. 仅按 `user/message` 类型投影会显示插件注入提示。目视截图发现后，改为 `source.kind === user` 白名单；追加 7 个投影回归测试，过滤 plugin/catalog/unknown，验证旧回合不完成新请求、错误/取消/审批拒绝不会被 HTTP 200 覆盖。初始问题截图和旧报告保留，现行 smoke 增加内部文本泄漏断言并通过。
3. Starter 的 Next 16.2.12 存在已知漏洞，未照搬版本锁。更新 Next 16.3.5 后 npm audit 为 0；原始和新扫描均保留。对应公告：GHSA-p293-qw3h-jr36、GHSA-2xp9-vwfh-vxw4。
4. 宿主默认 Node 25 不在一个传递依赖支持范围，实际服务/测试/构建使用 bundled Node 24.19.0；生产固定 Node 24。

类型检查与 Next production build 通过；SBOM 和 335 个锁定平台依赖条目已生成，未知许可证 0。sharp/libvips 的 LGPL 分发义务明确留到 P8 制品门禁，不把许可登记当作二进制分发合规完成。

## 安全边界与范围

- Browser 只持有 Better Auth Cookie，不知道 Alpha bearer，也不能选择 runtime/owner。Session owner 由 PostgreSQL 绑定；跨用户 HTTP 404、WS 403，审批跨用户拒绝。
- 现有 Alpha gateway 保持停止；新 gateway 无公开端口，单独写 R1 evidence。BFF 临时副本在 `.research/spike-alpha`；Alpha 源码未改，174 个历史 evidence 摘要仍相同。
- 真正 Provider Key 只由 gateway 内扫描程序访问；R1 源码/文档/证据扫描未发现它或本地生成的认证/数据库测试秘密。
- Spike relay 的合成 `user_a/user_b` 映射只用于验证组件接口，不进入生产。R1 不证明 Runtime Manager、持久审批、Web 文件、完整 RBAC/ACL、负载或生产 Compose 已完成。
- 本地 HTTP 未验证 Secure Cookie/TLS；附件完整协议、线程标题/分页和断线 cursor 要在 P3/P5 实现。失败状态投影有单元证据；实际生产故障注入仍属于后续 Gate。

## 结论

三个最小 Spike 通过，支持选用组合基础。无需替换 Harness，也无需 Full Fork AI 平台。下一步 R2 将候选提升为正式 Foundation，并从同一计划继续 P1。
