# 构建目录与版本留存

这套流程区分临时输入、最终制品和历史版本。不会在发布成功后自动删除服务器历史版本、原有备份或用户资料。

## 构建入口

继续使用 `deploy.sh`、`restage-host.sh`、`restage-web.sh`。

- Host 只冻结 packages、锁文件、TypeScript 配置、VERSION 和部署脚本，不展开 Java 后端或 Rust 源码。
- 网页构建冻结网页组件；管理端需要更新时再加入 plus-ui。不会展开 Rust、Java 后端、旧 out 或整个仓库。
- 完整构建仍可在临时目录冻结完整提交，以兼容 Java 和镜像来源校验；它不会永久保存该快照。
- 三个入口都从 Git SHA 取输入，不复制当前未提交代码。依赖仍先比较锁文件再链接已有缓存。

默认目录：

```
.codex/build-tmp/zw-build-随机值/        临时 source/target/dist/stage
.codex/release-artifacts/发布编号/
    BUILD.json                        SHA、输入范围、状态、校验值、清理结果
    artifacts/                        仅本次生成的最终制品
```

退出、失败、INT、TERM 都触发本次临时目录回收。失败只保留构建状态，部分产物不会混入最终制品。临时清理失败会记录路径、返回非零，并保护该记录；可排除原因后用 `workspace.py close --work 路径 --exit-code 原退出码` 重试。SIGKILL／断电无法执行退出钩子，此类遗留目录需按 OWNER.json 核对，不凭 PID 消失或时间过期直接删。

环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ZHENWORK_BUILD_TMPDIR` | 仓库 `.codex/build-tmp` | 本次临时编译目录 |
| `ZHENWORK_RELEASE_ARTIFACTS` | 仓库 `.codex/release-artifacts` | 最终制品及记录 |
| `ZHENWORK_MAX_PENDING_CANDIDATES` | `10` | 待验收／构建中／清理失败候选上限；到达后拒绝继续新增，保护已有候选 |

已有同名制品目录不会被覆盖。远端已有同 SHA 发布也沿用原有复用检查。

## 候选与验收

构建并 staging 成功只记为 `candidate`，不会自动记成生产通过。完成真实验收后，使用包含同一 `sourceSha` 和明确 `status: PASS`、`verdict: GO` 或 `verified: true` 的已审核回执登记本地验收：

```sh
python3 deploy/tencent/maintenance/workspace.py accept \
  --record .codex/release-artifacts/发布编号 --receipt 私有验收回执.json
```

命令同时要求临时回收已完成。未知格式或不匹配 SHA 的回执会拒绝；不要为了清理空间伪造通过记录。失败构建记录本身很小，不将它当成已验收版本删除。

## 历史版本留存

`retention.example.json` 提供可调整的数量、期限、固定保留版本和受保护产品版本。默认普通已验收版本保留最近 3 个，超过数量或 30 天的版本可进入清理计划；正式版、current、previous、固定保留项和待验收候选不受该淘汰规则影响。

服务器以实际 `current`、`previous` 链接判定运行和回退对象，链接缺失／越界即拒绝；正式 RC1 根据元数据强制保留，示例另外保留 1.0.1。待验收增量候选的直接基线也受保护。不会沿已组装成完整制品的版本来源链无限保留所有历史版本。

旧回执格式不明、没有匹配 SHA 的验收证明或元数据损坏时默认保护。核对原始证据后，可在策略 `verifiedReleases` 中以“发布编号: 实际 SHA”显式登记旧版本的已验收状态；这不会覆盖待验收候选状态。

本地 `--layout local` 使用 BUILD.json；它无法替代对远端运行状态的查询。应用前必须将当前／回退／正式制品加入本地策略的 protectedReleases，且在部署或回退后刷新这些保留项。示例中的两个试点发布编号来自 11-07 记录，不是动态线上状态。

默认只输出计划：

```sh
# 在实际服务器上运行，策略文件由维护者审核保存；此命令不删除。
python3 retention.py plan --layout server --root /srv/apps/zhenwork/releases \
  --policy 私有留存策略.json > 留存计划.json
```

审核计划后，显式指定该计划及其 fingerprint 才能执行：

```sh
python3 retention.py apply --plan 留存计划.json --approved-fingerprint 已审核的指纹
```

执行前会重算计划；内容被修改、运行指针改变、目录身份或元数据变化都会拒绝。服务器 apply 要求先安装配套 activate.sh、build-linux.sh 的共同 `.release-operation.lock`，与切版、回退、发布目录创建互斥；未安装时只能生成计划。计划不包含 shared、incoming、备份目录、数据库或其他项目。

清理遇错立即停止并返回非零，不继续删其他版本；结果记入同一 `.retention-history.jsonl`，最多保留 100 条。历史删除必须先有明确授权和审核后的计划，本轮没有执行服务器或本地历史版本删除。

## 既有目录与验证

旧 `.codex/tencent-build`、`tencent-host-restage`、`tencent-web-restage` 可用 `--layout legacy` 分别生成计划。工具读取已有 release/stage 下的 IMAGE_IDS.json 和 SOURCE_SHA；缺少匹配验收回执时一律保护。核对实际验收记录、运行／回退角色以及源码快照无独有修改后，才能在策略 verifiedReleases 中登记对应 SHA 并重新审核计划。它们不会自动迁移或整包删除。

```sh
python3 deploy/tencent/maintenance/retention.py plan --layout legacy \
  --root .codex/tencent-host-restage --policy 私有留存策略.json
```

新构建开始使用新的目录布局，避免继续积累同类快照。

旧 QA 应用及五个 RC1 候选包的逐项待清理清单在工作区根目录 `待清理清单.md`，确认前不删除。正式 RC1 包、其校验、手册、验收与许可资料保留。

运行 `just verify` 检查 shell 语法、既有维护规则及临时 Git／发布树中的定向行为。测试覆盖构建退出／中断回收、失败处理、候选上限、正式版／当前／回退／待验收保护、计划篡改与状态变化拒绝。它不部署生产、不调用模型、不生成 Office 文件。
