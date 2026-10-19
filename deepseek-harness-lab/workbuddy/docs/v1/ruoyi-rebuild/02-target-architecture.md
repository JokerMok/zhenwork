# RC2 目标架构

状态：设计已确定，实施与验收未完成。

统一入口承载 `/` 员工 Workspace、`/admin` 官方 Vue 管理端、`/api` RuoYi API、`/ws` 自有事件流。数据库、Redis、Gateway、Manager、Runtime 均不公开。开发阶段新旧实例分端口、数据库、卷与服务凭据；对某实体同时只有一个写权威。

## 控制面

RuoYi + Sa-Token 管身份和登录；原生系统表管用户、部门、角色、菜单。独立 ruoyi-ai 扩展管理资源、版本、动作 ACL、共享审核、Provider/Model、文件知识、会话/消息/Run、审批、审计、用量和品牌。原生 IAM 使用 BIGINT，JSON 一律十进制字符串，避免浏览器精度丢失；AI 业务 ID 使用 UUID，迁移保留或映射均需引用完整性校验。

AI 私有内容不复用通用超级管理员绕过。不把私人文件放进管理员可遍历的通用 OSS 列表。日志只存行为元数据；Provider、MCP Secret 和消息正文均不进入通用操作日志。

## 执行面

`AgentRuntimeClient` 定义 createSession、resumeSession、sendMessage、streamEvents、cancel、approve、deny、history、health、shutdown。唯一实现 DeepSeekHarnessAdapter 将固定 Harness 的原生事件归一化。员工前端只消费自有协议。

RuoYi 在数据库事务内冻结 Run 配置与资源版本，签发短期授权能力（audience、subject、sessionId、runId、scopes、expiresAt、authVersion、nonce）。Manager 只做独立用户容器生命周期及 Adapter 调用；Gateway 只做受权 Provider 调用与计量回传。它们不得查旧业务权限表或自行扩大授权；每次敏感动作复核控制面状态，控制面不可达时拒绝。

Runtime 原生历史是执行检查点；RuoYi 的消息、事件与 Run 才是业务读取权威。事件写入、序号、工具动作去重和用量幂等有持久化约束，不能只依赖进程 Map。审批绑定具体 Run、工具、参数摘要和有效期。

## 分阶段边界

R2 先启动官方原生控制面，R3 完成统一身份和品牌，R4 最小模型/会话/真实执行链。R4 之前不展开全部资源 CRUD。R5 后扩展通用资源模型；每新增能力都要在真实 Run 生效。RC2 Gate 通过前，RC1 实例仍是基线参考，不能把新旧登录混作统一身份。

## R4 实际接线

可信 HTTPS3582：/admin→官方 Vue3581；/→独立 Next Employee3583；/api 与 /ws→RuoYi3580。旧 BFF 不在 RC2 核心路径，尚未执行全功能 legacy-off 或 Cutover。

Java DeepSeekHarnessAdapter→本机 Execution Manager3584→每用户独立固定镜像 Runtime。独立 Gateway3585 只接收该 Runtime IP 与实例随机凭据；Manager/Gateway 不连接旧业务数据库。每次模型请求、每个输出帧回到 RuoYi 验证当前 Run、账号/权限版本和模型授权。内部回调需要独立 HMAC service credential，执行 grant 绑定 user/session/run/resource scope/authVersion/expiry。

Provider 使用 AES-256-GCM 密文，主密钥在私有外部文件，浏览器模型列表不返回秘密。R4 仅种入既有授权 Ark 模型用于提前验证真实链路；动态 Provider 管理、扩展目的地址策略、完整用量/调用审计仍属于 R6/R12。真实初始凭据来源和操作证据保存在本地私有配置，不进入 Git。

AI 文本路径不经过原生 HTML 标签清洗，以保留代码与模型输出；React/Vue 按文本渲染，不使用 raw HTML。关闭原生请求正文日志，避免记录 prompt、执行 grant 或后续 Provider Key；登录/操作审计保留，AI 专项审计待 R12。

## R6 模型配置与出站请求

RuoYi 持有 Provider、Model、四种模型授权范围和真实连接测试记录。密钥以 AES-256-GCM 保存，API 仅返回 configured 与 secret_updated_at，编辑留空保留原值；明确输入才替换。每次更改 Provider/Model 递增版本、撤销受影响在途 Run，新 Run 读取新配置。Gateway 读取密钥时同时匹配 Provider 版本，避免并发更新造成旧地址与新密钥混用。

Gateway 支持 OPENAI_CHAT 协议的 ARK、OPENAI、DEEPSEEK 与 CUSTOM_OPENAI 配置；当前真实凭据验收只覆盖 Ark/Doubao。其它服务商须使用其真实账号验证，不能沿用 Ark PASS。自定义服务只允许 HTTPS/443，拒绝 URL 凭据、查询串和私网地址；每次请求解析全部 IPv4 地址、检查后将连接固定到已验证地址，不跟随重定向。仅对收到的 429/502/503/504 在响应输出前进行有限重试，不重试不确定的网络失败或已流出的内容。IPv6 连接暂未支持。

Runtime 中 workspace-selected 是执行通道别名，真实 Provider/Model ID 来自 RuoYi Run 快照，由 Gateway 转发。新增和修改模型无需重建镜像。上下文上限在 Gateway 按 UTF-8 字节做保守边界检查；默认 temperature/top_p 和输出上限由模型配置决定。非流式上游结果可转换为统一流事件。视觉输入未实现，API 明确拒绝启用。

模型授权统一使用 ai_model_policy；R4 临时授权已由 SQL 0009 迁移，原表只读归档，不参与授权判断。当前授权页面支持全体员工、角色、部门、用户，原生 IAM 决定成员资格。
