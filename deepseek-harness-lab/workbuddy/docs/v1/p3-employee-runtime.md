# P3 员工工作台与正式执行链路

员工通过 Better Auth Cookie 访问统一入口。BFF 将身份映射到 PostgreSQL 会话和独立运行环境；浏览器不能指定 owner、容器、镜像、路径、模型凭据或工具执行结果。

## 复用与实现

- ADOPT assistant-ui 0.15.20 的 Thread、ThreadList、Message、Composer、Markdown、Retry，ExternalStoreAdapter 接正式 WebSocket；固定版本适配尚不稳定的 threadList 回调，升级须重跑契约与浏览器用例。
- ADAPT 已登记的 Dashboard Sidebar、Button、Card、Input 和 Tool UI ApprovalCard。未引入第二套 Agent。
- BUILD 企业适配器、可信 Manager 和 Gateway，沿用固定 Harness SHA，外置插件与配置，不改上游核心。
- 员工九个入口已建立；会话、助手、任务历史、审批、账户设置和生成文件列表连接正式 API。企业知识、文件上传与附件适配在 P5 完成，管理后台在 P4 完成，当前不称完整产品。

## 数据与生命周期

会话/执行/审批/安全投影落 PostgreSQL，前端持有单调递增 revision。请求有按员工约束的幂等键，同一员工同时只执行一个任务。服务重启把未终结任务标记为中断，用户可恢复历史；不自动重放可能产生副作用的操作。

WebSocket 只发布真实用户消息、助手文字与中文工具状态；插件注入上下文、工具原始参数、运行时 token 不公开。每次广播及 5 秒心跳重新验证账号和会话权限；慢连接限缓冲后关闭。前端重连取当前持久快照。审批绑定 owner、session、run、参数摘要和单次消费标记。

取消先落服务端 cancelling 状态；执行结束竞态统一判为 Cancelled。前端立即点击停止时等待请求入库后发送取消。最近任务查询与聊天列表共享 React Query 缓存，避免返回历史页时选择过期列表。

Manager 独占进程锁，按员工建立 internal network、独立命名卷、非 root/只读根/全部 capability drop/no-new-privileges，无宿主 HOME、Docker socket、对外端口或 Provider key。本机 Docker 总内存约 8 GiB，同时还有其他项目，当前限制 4 个常驻员工环境并逐出空闲环境；此数字不是 20 并发验收。

## 文件与能力边界

默认关闭 shell、任意文件系统和插件管理能力。外置工具只允许工作目录内单层文本文件名，读使用 O_NOFOLLOW，拒绝硬链接，写通过临时文件原子替换。导出需员工审批，经当前权限与参数摘要校验后进入 BFF 文件存储。企业知识和目录查询当前明确返回 KnowledgeError，P5 接真实动态权限检索。

## 已发现并修复

1. 原生依赖向 noexec /tmp 提取导致启动失败：使用上游已提供 NARB_DISABLE_NATIVE_CACHE=1，保持 noexec。
2. 实际模型适配器发送 store:false、max_completion_tokens 和文本数组：Gateway 按实际协议只接受这些已确认结构，仍拒绝任意 Provider/URL/图像字段。
3. 快速取消与任务结束竞态；旧任务列表缓存；启动失败丢失历史；删除会话前资源释放顺序。

初始失败证据保留，不用最终 PASS 覆盖已发现的问题。验证详情见 evidence/v1/p3/，真实浏览器使用合成员工，不能代替不同真实设备验收。
