# Enterprise AI Workspace

单企业私有部署、多员工使用的 AI 工作台。Workbuddy 仅为内部代码名；界面名称、Logo 和品牌色由管理员配置。固定 DeepSeek Harness 是唯一 Agent Runtime。

当前：R0–R2、P1–P7 已完成本地阶段验收；P8 双架构镜像、ARM64 实际部署/恢复/升级、安全回归及二十请求排队通过。P9 最终镜像公网 HTTPS/WSS 与真实 Chrome 合成账号测试通过，独立设备与真实 Linux AMD64 仍待验收。**尚未发布 v1.0.0，也不称 Production Ready。**

- [现行主计划与 Gate](docs/v1/00-master-plan.md)
- [员工与管理员使用说明](docs/v1/user-admin-guide.md)
- [安装、启停、备份恢复和升级手册](docs/v1/deployment-runbook.md)
- [P8 实际验收及限制](docs/v1/p8-deployment-operations.md)
- [P10 双架构候选交接](docs/v1/p10-candidate-handoff.md)
- [本机 RC / Quick Tunnel 人工验收与停止命令](docs/v1/local-remote-acceptance.md)（当前工作；暂不进入 P11）
- [远程验收与临时入口关闭](docs/v1/p9-remote-acceptance.md)
- [第三方来源及许可](THIRD_PARTY_NOTICES.md)

产品代码位于 `apps/`、`packages/`、`runtime/v1/`，部署定义位于 `deploy/v1/`。`src/` 与下述 Alpha 内容保留为历史基线，不能作为 V1 的安装入口。状态入口为 `.codex/PROJECT_STATE.md`。配置、凭据、业务数据和备份密钥保存在不进入 Git 的实例目录。

开发检查使用 Node.js 24：`npm ci`、`npm run lint`、`npm run typecheck`、`npm test`。需要真实模型和容器的测试只在明确的合成验收实例执行；不能拿单元测试替代实际执行链路。

---

# 历史 Alpha — 企业边界验证

最终 Gate：**PASS（固定 Harness SHA + 豆包 + 两用户合成 Alpha）**。

[完整报告](reports/workbuddy-alpha-validation-report.md) · [98 项攻击/正向控制明细](reports/attack-matrix.md) · [执行记录](evidence/execution-ledger.md)

验证模型：`doubao-seed-2-0-mini-260428`。这不表示 DeepSeek API 已通过。没有 UI、正式 IAM 或业务功能；不接真实企业资料。

## 结构

- `src/model-gateway.mjs`：唯一可读原 Ark 凭据的模型网关；固定上游，无宿主端口。
- `src/bff.mjs`、`runtime-client.mjs`：loopback HTTP/WS 身份与资源 owner 校验，独立 stdio Runtime。
- `src/runtime-bridge.mjs`：外置 Harness 插件，复用官方 agent/session/tool/approval 能力。
- `src/knowledge*.mjs`：执行侧 ACL 与合成 stdio MCP。
- `src/*Dockerfile`：实际构建定义；`.build/` 保存本轮 archive 和构建上下文。
- `src/provision-runtimes.py`：首次创建独立容器与纯合成用户分区；已存在容器时拒绝覆盖。
- `fixtures/skills/`：共享只读测试 Skill；`fixtures/acl-negative/` 仅在独立无网络测试容器使用，不挂载给用户 Runtime。
- `tests/`：真实模型、攻击、容器、审批、恢复与密钥检查。
- `.state/`：测试密码、内部 token、Session owner registry 和各用户数据，不提交；无 Ark Key 副本。
- `evidence/`：真实命令/请求/状态/usage/合成事件与历史失败。

## 恢复本轮已有环境

本轮交付后已停止 BFF 和三个实验容器，镜像和合成数据保留。

```sh
docker start wb-alpha-gateway wb-alpha-a wb-alpha-b
node src/bff.mjs
```

BFF 打印就绪端口并写入 `.state/bff.json`。测试读取 `.state/users.json` 在服务端登录，不要把内部测试密码或 token 输出到终端/报告。

```sh
node tests/adversarial.mjs
node tests/container-boundary.mjs
```

需要完整真实模型复验时使用 `tests/harness-e2e.mjs`；审批标记文件应先另存或使用全新合成 Workspace，不能把之前落盘的标记当作本轮通过。新进程恢复专项依赖主验收输出和一次真实 BFF 重启，见执行记录。

不要对已有环境重新运行 provisioning；它属于首次创建，不是启动命令。源码上游保持固定 SHA，不改 Core；新增模型、插件、挂载或外网访问后需要重验。

停止：向 `.state/bff.json` 中该 BFF 的 PID 发送 SIGTERM，待其退出后 `docker stop wb-alpha-a wb-alpha-b wb-alpha-gateway`。只管理本项目三个明确命名容器。
