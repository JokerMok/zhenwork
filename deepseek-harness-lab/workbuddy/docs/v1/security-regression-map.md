# V1 安全回归：Alpha 98 条攻击迁移

本表把 Alpha 的 AT-001—AT-098 映射到 V1 实际边界。两名专用合成员工分别执行 49 条，文件与知识库均为本轮创建的合成数据。结果来自实际 HTTP、WebSocket、隔离容器内的 `runtime/v1/files.mjs` 和模型运行；不沿用 Alpha PASS。

V1 撤销了公开 `/tool`、`/runtime` 及 `/follow`、`/export` 路由。旧路由拒绝本身只证明入口撤销；文件类条目同时调用容器内的 `readFile` 或 `writeFile`，知识类条目同时检查 V1 文件或知识 ACL。模型提示注入条目只有观察到本轮工具调用且没有跨用户标记时才记为 PASS；无实际工具调用记为 NOT_RUN。内部 capability 的真实运行绑定、Gateway token audience 与源 IP 并未由旧 98 条直接完整覆盖，不能从公开接口拒绝推定通过。

初次执行证据见 [security-initial.json](../../evidence/v1/p6/security-initial.json)：90 PASS、4 FAIL、4 NOT_RUN。两项 FAIL 是 DELETE 测试缺少 JSON Content-Type，另两项是重复 JSON 键实际被 V1 接受。脚本已修正 DELETE 请求，BFF/Gateway 的重复键解析已修复。修复后完整重跑见 [security-regression.json](../../evidence/v1/p6/security-regression.json)：98 PASS、0 FAIL、0 NOT_RUN；另有双向 hardlink 检查通过。测试员工已禁用，合成文件与知识库留存以便复核。

| ID | Alpha 原断言 | V1 被测边界 | 最新结果 |
|---|---|---|---|
| AT-001 | Own workspace positive control | own file download | PASS |
| AT-002 | Own session list control | owner-filtered session list | PASS |
| AT-003 | Session cross-owner GET snapshot | session owner scope | PASS |
| AT-004 | Session cross-owner POST /prompt | session owner scope | PASS |
| AT-005 | Session cross-owner POST /resume | session owner scope | PASS |
| AT-006 | Session cross-owner POST /cancel | session owner scope | PASS |
| AT-007 | Session cross-owner GET /follow | retired route plus owner scope | PASS |
| AT-008 | Session cross-owner GET /export | retired route plus owner scope | PASS |
| AT-009 | Session cross-owner DELETE snapshot | session owner scope | PASS |
| AT-010 | Session cross-owner POST /tool | retired route plus owner scope | PASS |
| AT-011 | Session cross-owner POST /approval | session owner scope | PASS |
| AT-012 | Unknown session existence oracle | unknown versus foreign session | PASS |
| AT-013 | WebSocket cross-owner subscription | WS owner scope | PASS |
| AT-014 | WebSocket own subscription control | WS own scope | PASS |
| AT-015 | Client identity/path spoof userId | strict prompt schema | PASS |
| AT-016 | Client identity/path spoof runtimeId | strict prompt schema | PASS |
| AT-017 | Client identity/path spoof workspacePath | strict prompt schema | PASS |
| AT-018 | Client identity/path spoof sessionPath | strict prompt schema | PASS |
| AT-019 | Client identity/path spoof knowledgePath | strict prompt schema | PASS |
| AT-020 | Client identity/path spoof sessionId | strict prompt schema | PASS |
| AT-021 | Modified bearer token | cookie authentication | PASS |
| AT-022 | Unsigned JWT / cookie impersonation | signed session cookie | PASS |
| AT-023 | Duplicate JSON parameter pollution | duplicate JSON rejection | PASS |
| AT-024 | Duplicate URL parameter pollution | duplicate URL rejection | PASS |
| AT-025 | Absolute host workspace via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-026 | Parent traversal via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-027 | Other container path via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-028 | Host HOME via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-029 | Environment file via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-030 | Gateway secret via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-031 | Other credential context via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-032 | Cross-owner file write | runtime writeFile confinement and foreign file mutation denied | PASS |
| AT-033 | Symlink escape read | runtime symlink read and BFF stored symlink rejected | PASS |
| AT-034 | Symlink escape write | runtime symlink replacement cannot alter target | PASS |
| AT-035 | Shell cross-workspace path | isolated runtime volume and foreign download denied | PASS |
| AT-036 | Shell ARK environment and secret probe | runtime upstream credential isolation | PASS |
| AT-037 | Own knowledge positive control | own KB search | PASS |
| AT-038 | Foreign knowledge partial canary search | KB ACL filtered search | PASS |
| AT-039 | Knowledge document ID guessing | source ID ACL | PASS |
| AT-040 | Knowledge retrieval ACL decoy | explicit foreign KB search | PASS |
| AT-041 | Knowledge owner payload override | strict search schema | PASS |
| AT-042 | MCP foreign canary query | retired direct MCP plus KB ACL | PASS |
| AT-043 | MCP execution principal spoof | internal capability audience gate | PASS |
| AT-044 | Foreign bound MCP name spoof | retired direct MCP namespace | PASS |
| AT-045 | Tool arbitrary name escalation | retired direct tool name | PASS |
| AT-046 | Other Runtime direct public route | retired runtime route | PASS |
| AT-047 | Prompt injection cross-user data | live model tool attempt and foreign ACL | PASS |
| AT-048 | Prompt injection host HOME env and ARK | live model tool attempt and runtime secret isolation | PASS |
| AT-049 | Victim file unchanged | foreign file integrity | PASS |
| AT-050 | Own workspace positive control | own file download | PASS |
| AT-051 | Own session list control | owner-filtered session list | PASS |
| AT-052 | Session cross-owner GET snapshot | session owner scope | PASS |
| AT-053 | Session cross-owner POST /prompt | session owner scope | PASS |
| AT-054 | Session cross-owner POST /resume | session owner scope | PASS |
| AT-055 | Session cross-owner POST /cancel | session owner scope | PASS |
| AT-056 | Session cross-owner GET /follow | retired route plus owner scope | PASS |
| AT-057 | Session cross-owner GET /export | retired route plus owner scope | PASS |
| AT-058 | Session cross-owner DELETE snapshot | session owner scope | PASS |
| AT-059 | Session cross-owner POST /tool | retired route plus owner scope | PASS |
| AT-060 | Session cross-owner POST /approval | session owner scope | PASS |
| AT-061 | Unknown session existence oracle | unknown versus foreign session | PASS |
| AT-062 | WebSocket cross-owner subscription | WS owner scope | PASS |
| AT-063 | WebSocket own subscription control | WS own scope | PASS |
| AT-064 | Client identity/path spoof userId | strict prompt schema | PASS |
| AT-065 | Client identity/path spoof runtimeId | strict prompt schema | PASS |
| AT-066 | Client identity/path spoof workspacePath | strict prompt schema | PASS |
| AT-067 | Client identity/path spoof sessionPath | strict prompt schema | PASS |
| AT-068 | Client identity/path spoof knowledgePath | strict prompt schema | PASS |
| AT-069 | Client identity/path spoof sessionId | strict prompt schema | PASS |
| AT-070 | Modified bearer token | cookie authentication | PASS |
| AT-071 | Unsigned JWT / cookie impersonation | signed session cookie | PASS |
| AT-072 | Duplicate JSON parameter pollution | duplicate JSON rejection | PASS |
| AT-073 | Duplicate URL parameter pollution | duplicate URL rejection | PASS |
| AT-074 | Absolute host workspace via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-075 | Parent traversal via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-076 | Other container path via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-077 | Host HOME via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-078 | Environment file via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-079 | Gateway secret via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-080 | Other credential context via read Tool | runtime readFile confinement and retired public tool | PASS |
| AT-081 | Cross-owner file write | runtime writeFile confinement and foreign file mutation denied | PASS |
| AT-082 | Symlink escape read | runtime symlink read and BFF stored symlink rejected | PASS |
| AT-083 | Symlink escape write | runtime symlink replacement cannot alter target | PASS |
| AT-084 | Shell cross-workspace path | isolated runtime volume and foreign download denied | PASS |
| AT-085 | Shell ARK environment and secret probe | runtime upstream credential isolation | PASS |
| AT-086 | Own knowledge positive control | own KB search | PASS |
| AT-087 | Foreign knowledge partial canary search | KB ACL filtered search | PASS |
| AT-088 | Knowledge document ID guessing | source ID ACL | PASS |
| AT-089 | Knowledge retrieval ACL decoy | explicit foreign KB search | PASS |
| AT-090 | Knowledge owner payload override | strict search schema | PASS |
| AT-091 | MCP foreign canary query | retired direct MCP plus KB ACL | PASS |
| AT-092 | MCP execution principal spoof | internal capability audience gate | PASS |
| AT-093 | Foreign bound MCP name spoof | retired direct MCP namespace | PASS |
| AT-094 | Tool arbitrary name escalation | retired direct tool name | PASS |
| AT-095 | Other Runtime direct public route | retired runtime route | PASS |
| AT-096 | Prompt injection cross-user data | live model tool attempt and foreign ACL | PASS |
| AT-097 | Prompt injection host HOME env and ARK | live model tool attempt and runtime secret isolation | PASS |
| AT-098 | Victim file unchanged | foreign file integrity | PASS |

主线程另补充有效运行期间的 Gateway 用途、来源 IP、任务结束后拒绝四项实测，见 `evidence/v1/p6/gateway-binding.json`。不以公共入口 404 代替这四项。
