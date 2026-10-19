# V1.0 系统架构

状态：目标架构；各模块是否实现以阶段证据为准。新增控制面与共享契约使用 TypeScript strict，Node 24；现有 ESM Alpha 保留作冻结回归，Harness 不改 Core。

```text
Browser → TLS reverse proxy → web 静态资源
                           → BFF（employee/admin 分区、IAM、ACL、文件、审计）→ PostgreSQL
                                 ↓ 私有认证 API
                           Runtime Manager → 每用户独立容器/网络/卷
                                 ↑ stdio             ↓ 限权凭据
                              Harness          Model Gateway → 固定 Ark HTTPS
                                                     ↓ 执行时授权
                                              Knowledge capability API
```

## 已选复用基础

R1 已验证 assistant-ui Custom Runtime Adapter → BFF WebSocket → Harness、Better Auth → PostgreSQL → BFF identity、Admin Starter → API → BrandConfig。三个 Spike 已在 R1 实际通过，R2 已接受组合 Foundation；禁止把候选自带 Agent、Provider、SaaS、Billing 或 Clerk 服务接入主链。唯一核心 Agent Runtime 保持 Harness。

## 服务职责与边界

- reverse-proxy：唯一公网入口，域名/Host 白名单，80 重定向 443，TLS、安全头、请求体上限、流式不缓冲。不保存业务密钥。
- web：Next.js 16.3.5 standalone 服务，React/assistant-ui + 精选 dashboard/tool-ui；独立品牌员工端和管理员端；同源 API，禁连 Runtime；无 Provider Secret。
- bff：身份映射、RBAC、资源 owner、知识权限、文件中转、任务状态、审计/用量。无 Docker socket、无 docker CLI、无任意宿主挂载。
- runtime-manager：唯一 Docker 管理服务；仅私网最小 API。输入为已核验用户 UUID/会话 UUID/白名单操作，不接收 image/volume/path/command/env/network。固定镜像 digest 和模板，默认拒绝。宿主 daemon 等同高信任控制面，不能当普通 Web 服务。
- model-gateway：唯一 Provider Secret 持有者；固定批准上游，内部 token 绑定用户/实例/有效期/audience；模型权限/用户禁用/预算由 DB 原子检查。body 白名单、超时、流式终态、限长脱敏日志。
- postgres：业务权威和事务锁；migrator 与 runtime DB role 分离；应用不能修改历史审计。初版不引入 Redis/消息总线。
- worker：只有确需异步扫描/索引时才使用同代码的 worker 进程，以 DB jobs + SKIP LOCKED 领任务，幂等、租约、失败重试。

## 身份与通信契约

浏览器只有 HttpOnly opaque session cookie，BFF 取 DB 会话与当前用户权限。管理员 API 和员工 API 每次独立鉴权。内部服务令牌不同 audience，Runtime 获得的 token 无法调用 Manager 管理接口。内部 API 全部有 requestId、body 长度/字段校验和超时。Docker 私网是额外隔离，不能替代接口认证。

Runtime 只通过 stdio 接受命令；Manager 连接与生命周期归同一控制服务。每用户一个独立 Runtime 可有多个 Session，单 Session 命令串行，取消/审批走专用控制通道不被长请求阻塞。DB 保留 user → runtime instance → session 关联；browser 不得提供 runtimeId/owner/path。Manager 重启可发现带正确产品 label 的容器，核对配置和 image digest 后恢复；不得接管名称相似的外部容器。

## Runtime 生命周期

状态 absent/provisioning/stopped/starting/ready/busy/stopping/failed。用户级 DB advisory lock 防重复创建，启动幂等；健康通过后才接任务。idle shutdown 初始 15 分钟，审批或活动任务不停止；失败重启退避且有次数上限。CPU/memory/PID/并发预算可由运维设置但有安全下限与上限，不能被员工覆盖。退出前 cancel → flush → dispose → 等进程退出，超时记录 interrupted。保留 workspace/session 卷；临时 /tmp 不备份。

每用户独立 internal network；Runtime 仅可访问所属 Gateway/知识代理入口，无公网、无其他用户网络、无 DB/Manager 管理入口。固定非 root UID、只读 rootfs、cap_drop ALL、no-new-privileges、资源上限，不挂宿主 HOME/真实密钥/socket。共享 Skill 只读且受审查。默认关闭 bash 与动态插件安装；保留原 Alpha bash 攻击测试为受控回归，不转为产品能力。

## Session、执行与错误

Harness Session 日志存在用户私有卷，业务 ownership/任务状态/审批存 DB。BFF 返回安全投影，不直接把含工具路径/内部信息的全量日志发送员工。流输出按会话和执行 run 绑定序列；断线通过持久快照+cursor 恢复，不能将旧回合成功当成当前提交结果。Harness `whenIdle` 只作为等待边界，结果取本次接受后事件区间的 turn/end、assistant error、tool result 与审批记录。

统一错误：code/type/retryable/userMessage/requestId；internalMessage 仅进脱敏内部日志。映射 CANCELLED、APPROVAL_DENIED、PROVIDER_FAILED、TIMEOUT、RUNTIME_CRASH、TOOL_FAILED、KNOWLEDGE_FAILED、PERMISSION_DENIED、RATE_LIMIT、INTERNAL_ERROR。非流 API 用适当 4xx/5xx；流已建立后发送 failure terminal event。错误重试不自动重复写操作。

## 复用与替换顺序

1. 固定上游与 Alpha 源码/证据摘要，建立 DB/CI，不替换已验底座。
2. 把 runtime-client 的 Docker 操作收进 Manager，保留 stdio 协议，增加契约和故障测试。
3. BFF 用正式 IAM/DB 接管 owner，不把 Alpha users.json 导入生产。
4. 保留工具 guard 思路，将知识静态挂载换成执行时授权 MCP；工具权限在执行时检查，变更使旧配置失效。
5. UI 消费稳定产品 API；完成容器/真实模型回归后再发布 artifact。

上游升级、原生模块和日志格式变化必须跑完整契约/攻击/真实模型/许可证门禁，禁止自动追随 master。

## R2 工程落位

`apps/web` 负责员工与后台；`apps/server` 是正式 BFF；`apps/manager` 持有 Docker 控制；`apps/gateway` 唯一持有 Provider Secret；`packages/contracts` 定义 Brand/Principal/Error/Event schema；`migrations` 保存 append-only SQL。Spike 保留在 `spikes/foundation`，不作为生产启动路径。Next standalone 和 API/WS 分开，统一入口同源转发。
