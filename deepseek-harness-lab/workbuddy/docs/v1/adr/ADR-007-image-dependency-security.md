# ADR-007：固定源码下的镜像依赖修补

日期：2026-09-20。状态：双架构最终镜像构建、原生模块及限定权限安全审查通过；ARM64 实际模型、知识、审批、安全、运维与公网浏览器复验通过。真实 Linux AMD64 仍待验收。

## 问题与证据

P8 整镜像扫描发现了 npm audit 未覆盖的操作系统包、Go 二进制和上游开发依赖漏洞。原始结果保留在 `evidence/v1/p8/*trivy-before-hardening.json`、`runtime-amd64-first-trivy.json`。这些结果不能通过隐藏严重级别或直接复用旧 PASS 消除。

固定 Harness 的完整开发安装还包含产品未使用的 Claude SDK、Codex CLI、CUA Driver 与 LibreOffice Kit。仅从后续镜像层删除不能解决分发层残留，因此在 builder 完成编译后、复制到最终阶段前裁剪。

## 决定

1. 官方 Harness checkout 和源归档保持固定 SHA，不修改 Core、Agent Loop、SDK 协议或源码锁文件。构建输入检查拒绝脏树和错误 SHA。
2. 可选平台可执行包不属于产品运行范围。构建副本的 workspace 与 lock 同步追加排除元数据，并只从派生 lock 移除被排除的可选引用，不修改任何包解析版本或其他引用；原文件及原始、派生哈希保留。先前全局配置被忽略、仅修改 workspace 导致 frozen 校验失败的证据均保留。
3. 依据上游 CLI 和 Python runtime closure 的生产依赖图移除不可达第三方开发包，保留工作区源码、manifest 和配置树。另显式排除上述未启用 SDK。外置 bridge 仍通过原 SDK 运行。
4. 对裁剪后仍保留的四个有修复版本的依赖，使用独立 npm lock：`fast-uri 3.1.6`、`ip-address 10.3.1`、`js-yaml 4.3.2`、`sharp 0.35.4`。在 builder 将旧物理包重定向至该锁定闭包，记录原版本、修补版本及清单哈希。不得把该产物描述为未经任何依赖调整的官方二进制。
5. Node 控制服务更新至当前 Node 24 Alpine 摘要，运行镜像移除 npm/yarn 并更新系统包；Runtime 使用 Debian 13 最终阶段，编译阶段独立。Node major 和 Harness 源码版本不变。
6. Runtime 删除不使用的 `infocmp` 程序，并移除最终文件系统中的 setuid/setgid 位；运行时仍强制非 root、无 capabilities、no-new-privileges、只读根目录。系统包未修复漏洞保留原始扫描，并依据实际组件和触发前提单列适用性判断。
7. Caddy 2.11.4 的官方镜像仍报告旧 Go 库。使用 Go 1.27.1 重建标准入口，锁定 `x/crypto 0.55.0`、`x/net 0.56.0`、`x/text 0.39.0`、`grpc 1.83.2`，保留最终 module 文件。Caddy Core 不作功能修改。

## 验收与回退

最终 image digest 必须重新接受 SBOM、漏洞扫描、真实模型会话、知识与文件、工具审批、98 项安全回归、HTTPS Cookie/WSS 以及升级/回滚验证。CLI import 或构建通过不能代替这些 Gate。

扫描保留全部严重级别；未修复或尚未判定的发现必须单列，不自动认定为误报。任何修补兼容性失败均拒绝候选，不自动回退到有漏洞产物并标 PASS。升级仍保留旧 digest、加密备份和 schema 兼容检查。

这项决定不更换 Agent Runtime，不引入第二套执行循环，也不解除真实 Linux、独立设备、目标容量和二进制分发验收门禁。
