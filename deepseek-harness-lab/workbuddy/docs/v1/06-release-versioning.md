# 版本、发布和上游策略

盘点：产品 package 无 version，workbuddy 无 Git；官方 Harness 有独立版本 0.1.6-alpha.2，不是产品版本。建立产品仓库，第一提交冻结 Alpha 源码/报告/安全证据摘要；不把 .state、凭据、node_modules、.build 或含测试会话的原始日志自动加入公开分发。

## 分支与版本

`main` 为已验稳定线；先保存 Alpha 基线，再建 `feat/production-foundation`，后续短分支按阶段完成合入。没有远端时只本地 commit，不擅自新建/推送公开仓库。Alpha 基线明确仅本地实验可运行，不冒充生产稳定版；Production main 的可部署承诺从通过的 release artifact 开始。

SemVer：P1 0.2.0、P2 0.3.0、P3 0.4.0、P4 0.5.0、P5 0.6.0、P6 0.7.0、P7 0.8.0、P8 0.9.0-rc.1、P9 1.0.0。实现中用 `-dev.N`，阶段目标不等于发布。版本不得无验收逐次机械提升。Local Bridge 没过 Gate 不标 Beta 可用，发布说明明确延后 1.1。

Conventional Commits（feat/fix/refactor/security/chore/docs/test）按范围；每阶段更新 VERSION、package version（适用时）、CHANGELOG、release notes、证据索引。commit 不含生成密钥/本机私有目录数据。tag 是发布行为，v1.0.0 仅 A–H 全绿后创建。

## Release Manifest

包含 product version、git commit/tree clean、config schema range、migration versions/checksums、Harness repository/version/SHA/archive digest、所有服务 multi-arch manifest+平台 image digest、SBOM/licenses/scans、安全/E2E/负载/外部部署证据哈希、备份/回滚兼容性。构建过程可复现，不能拿旧 image 和新源码组合签核。

## 上游锁

`upstream-harness.lock.json` 记录官方 repository、version、commit、source digest、image digest（平台分别）、verified date、compatibility status/evidence。初始历史支持只标 doubao Alpha Linux ARM64；AMD64/Production 未验证。固定构建 git archive，拒绝脏树/错 SHA；不自动 pull master。

上游升级独立 `upgrade/harness-*` 分支：更新锁 → build → contract → 原 98 回归 → V1 security → 真实模型全链路 → license/SBOM → 人工确认 → 合并。Config → Profile → Plugin → Wrapper → Bridge 优先；Core patch 必须 ADR 和独立 patch queue、rebase/撤销策略，不能混进官方 checkout。

## DB/config 升级和回滚

每次 DB 变化新 migration；每次不兼容 config 变化提升 schemaVersion、提供转化器和旧配置检测。migration checksum 不可改写。发布前对支持的上一版本真实数据运行 upgrade，再按声明的 schema 兼容范围运行 rollback；不兼容 schema 采用升级前备份恢复而非盲目 down。回滚可能丢失升级后的新增数据，必须在执行前明确而非静默覆盖。

## 发布阻断

任一关键 Gate FAIL/BLOCKED/NOT_RUN、重大未处理漏洞/许可证不清、secret scan 失败、缺任一架构 digest、缺外部双客户端证据都禁止 v1.0.0。保留失败证据和上一可部署 artifact；不以“功能基本完成”替代验收。

## 现行版本约束修订（2026-09-19）

上文 P1–P9 数字是第一版规划中的阶段建议，不是已发布版本；现行顺序按主计划 P1–P12。缺少真实 Linux AMD64 干净部署时，最高版本为 `v1.0.0-rc.x`；P9 公网临时入口通过不会触发 `v1.0.0`。只有 P11 的真实外部 Gate 与同候选 A–H 全部通过，才进入 P12。

`scripts/ops/candidate-manifest.mjs` 生成本地候选清单，写明源码 commit、dirty 状态、平台、各镜像 digest、固定 Harness、迁移 checksum 和未通过 Gate。清单同时绑定原始漏洞扫描、CycloneDX SBOM、限定权限审查、原生模块实测及本地部署证据的 SHA256；打包时逐项重验哈希。AMD64 清单中的 ARM64 部署报告明确标为跨平台参考，不能替代 AMD64 部署。它不会打 tag、发布镜像或自动把 Gate 改为 PASS。Runtime/Parser digest 随升级一起更新；同 schema 镜像回退同时恢复旧 Manager 配置，跨 schema 回退仍必须恢复到新实例。

本地 artifact 打包器 `scripts/ops/package-candidate.mjs` 要求源码 clean 且 commit 与 manifest 一致，输出产品源码、固定 Harness 源码、原生库源码包、镜像归档和 SHA256SUMS。当前只生成显式 `productionReady: false` 的私有验收包，不执行 registry push；包内保留验收限制，不带凭据、业务卷或备份密钥。对外分发仍需完成对应 Gate。
