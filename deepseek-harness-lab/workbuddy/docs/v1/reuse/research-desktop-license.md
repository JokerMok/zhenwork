# R0 桌面框架与受限许可证审计

审计时间为 2026-09-18。本文只回答 Local Bridge 的桌面框架选型和第三方参考边界，不构成法律意见。审计以官方 GitHub 仓库的固定提交或标签为准，没有安装依赖、构建、运行或跨平台测试。

## 结论

Local Bridge 的首选 Spike 基线暂定 **Tauri 2.11.5**。原因是 Tauri 2 已有稳定版本线，并提供面向窗口、WebView、命令和插件的 capability/permission/scope 机制。它更容易把前端调用面压缩到 `list/read/create/write/rename/export` 等明确能力。官方文件系统、更新器和 Stronghold 插件也能作为实现材料，但不能直接满足本项目的全部安全 Gate。

Wails v3 适合作为备选。Go 后端、原生 WebView、自动启动、系统凭据依赖和更新器实现都很完整，源码测试覆盖也较多；但截至固定提交，README 仍把 v3 标为 Beta，GitHub 的最新正式 Release 仍是 v2.14.0。`v3/internal/capabilities` 描述的是运行平台能力，并不是约束 JavaScript 调用 Go 方法的 ACL。若选择 Wails，应用必须自行实现并验证整个命令授权层。

这个判断只决定 Spike 顺序。它不证明 Tauri 更安全，也不代表任何平台已可发布。`LOCAL_BRIDGE_ENABLED=false` 必须保持不变，直到 macOS Apple Silicon 和 Windows x64 的真实构建、签名、安装、升级、卸载与攻击矩阵全部通过。

## Local Bridge 边界

设计依据为 `docs/v1/08-local-bridge-design.md`，SHA-256 为 `44aa890134255619e2c38aba62759bbd2e53dc23ca190c44d830cdbb3dc9928a`。

- 设备只向 `PUBLIC_ORIGIN` 建立 WSS/HTTPS 出站连接，不开放入站端口。
- 默认没有目录权限。目录必须由本地原生选择器选择，并按 read/write 分别授权。
- 服务器只能持有 `grantId`、显示名和权限，不能下发任意绝对路径扩大范围。
- 不提供 Shell、动态脚本和删除能力。覆盖写、rename、批量导出要绑定一次性本地审批。
- 路径检查必须覆盖 `..`、绝对路径、UNC/device path、ADS、NUL、大小写、保留名、symlink、junction 和 reparse point。单次 `realpath/canonicalize` 不能解决 TOCTOU；读写需要目录句柄和平台 nofollow 语义，做不到就拒绝该能力。

## 框架证据

| 项目 | 固定版本 | 许可证 | 与 Local Bridge 相关的证据 | 当前缺口 |
| --- | --- | --- | --- | --- |
| Tauri 2 | `tauri-v2.11.5`，提交 `7cd71369c00978a3783b6ae3e9972358abbe4ae6`，2026-07-01 | Apache-2.0 OR MIT | `crates/tauri-utils/src/acl/capability.rs` 定义 capability 与扩展 scope；`crates/tauri-build/src/acl.rs` 校验并生成 ACL；官方 `plugins/fs`、`plugins/updater`、`plugins/stronghold` 分别提供文件、签名更新和加密 vault 能力。核心仓库工作流覆盖 `aarch64-apple-darwin` 与 `x86_64-pc-windows-msvc`。 | `plugins/fs` 的 scope 与 `SafePathBuf` 不是目录句柄级 TOCTOU 证明，且 `write-files` 权限会启用无预配置路径的写命令。Stronghold 也不等于操作系统 Keychain/Credential Manager。必须写项目自己的 grant、nofollow/reparse、防覆盖与审批层。 |
| Wails v3 | `v3.0.0-beta.23`，提交 `7556ab76d3c939dce95f1afdf571704175a28702`，2026-09-16；审计头 `6d919787ca86ecea7db774517d3043da79b319d6`，2026-09-17 | MIT | `v3/pkg/updater` 有摘要与签名校验、周期检查和失败关闭测试；`v3/pkg/application/autostart*` 支持 macOS/Windows 自动启动；`v3/internal/keychain/keychain.go` 通过 `go-keyring` 使用系统凭据库；CI 与 Docker 交叉编译材料包含 Darwin arm64 和 Windows amd64。 | v3 仍是 Beta。没有与 Tauri capability 等价的前端命令 ACL；Go 后端一旦暴露文件方法，就拥有进程权限。内部 keychain 主要服务签名配置，并有环境变量回退，不能直接当作设备私钥保管方案。 |

### 文件系统

Tauri 的 ACL 能限制某个窗口或 WebView 可以调用哪些命令，并给插件命令附加 allow/deny scope。`plugins/fs/src/commands.rs` 在执行前解析并检查 scope，`SafePathBuf` 也拒绝不安全的路径组件。源码仍使用普通路径与 `std::fs` 操作，审计范围内没有找到覆盖 macOS 和 Windows 的目录句柄式 nofollow 方案。因此文件插件只能复用命令模型和部分路径解析思路，不能直接作为安全闭环。

Wails 不默认向前端开放通用文件 API，这减少了意外暴露；应用自行绑定的 Go 方法则没有框架 ACL。Spike 若使用 Wails，需要从零实现命令 allowlist、grant 绑定、参数摘要、审批、审计和平台文件句柄层。

### 更新、签名与凭据

Tauri updater 要求配置公钥，清单含平台下载地址和签名，下载后由 Minisign 校验；release 构建默认拒绝非 HTTPS 端点，除非显式打开危险配置。Tauri bundler 和 `tauri-macos-sign` 包含 macOS 签名、公证以及 Windows 安装包路径。官方 Stronghold 插件提供加密 vault，但 vault 密钥如何进入系统安全存储仍由应用决定。

Wails v3 updater 支持摘要校验和多种签名算法，并有 `verify_failclosed_test.go`。打包、更新和凭据相关代码已经进入 v3 源码，但 v3 仍处于 Beta。`v3/internal/keychain` 是内部工具能力，不能据此声称业务运行时已具备跨平台安全存储 API。

### 后台、出站与包体

两者都使用系统 WebView，没有证据表明 Local Bridge 必须开放入站监听。出站 WSS/HTTPS、断线处理、撤销和 nonce 仍需产品协议实现。Tauri 有系统托盘和官方 autostart 插件；Wails v3 有内置 autostart 与 updater 周期任务。任何后台常驻都必须在 UI 中可见、可停用，并服从设备撤销和 feature flag。

本次没有构建产物，也没有测量二进制、安装包、内存或启动时间。Tauri 的 release profile 设置了 `opt-level = "s"`、LTO 和 strip，Wails 文档把自身描述为 lightweight；这些只能说明项目关注体积，不能替代本项目实测。

### Docker 与迁移

Tauri 核心仓库的 `.docker/cross` 和工作流用于交叉构建/CI，CLI 还包含 v1 到 v2 的配置迁移。Wails v3 提供交叉编译 Dockerfile、Docker 构建任务和构建资产迁移测试。它们不是 Local Bridge 的运行时容器或业务数据迁移方案。审计范围内没有发现可直接复用的 Local Bridge 数据库迁移机制。

## 受限项目只作参考

以下项目均标记为 `REFERENCE_ONLY`。可以观察交互、信息架构和公开行为，不复制代码、样式资产、品牌元素或许可证附加条款覆盖的实现。是否可用于具体商业场景需要法务按固定版本和实际分发方式复核。

| 官方仓库与固定提交 | 根许可证事实 | 本项目边界 |
| --- | --- | --- |
| `open-webui/open-webui` `0a7c15832fb30b1903753e83f81dc7d27e5b0944` | 根 `LICENSE` 是 Open WebUI License，含品牌保留条件；`LICENSE_NOTICE` 说明不同提交区间适用 MIT、BSD-3-Clause 或 Open WebUI License。 | 不复制受限代码或品牌。历史文件的许可证不能自动覆盖后续修改。 |
| `langgenius/dify` `a81f6fed679d6ad74118845d6137615067ee7345` | 修改版 Apache-2.0；附加多租户和前端 LOGO/版权条件。 | 只作产品参考，不复用源码。 |
| `labring/FastGPT` `8a75e13c4ca0a8e8cb36bb7794f88e2c02ce61ad` | FastGPT Open Source License，基于 Apache-2.0，另有相似 SaaS、LOGO/版权等附加条件。 | 只作产品参考，不复用源码。 |
| `lobehub/lobe-chat` `b0ef4b2ef15d61b0be43bfa6f39d3524405ce374` | LobeHub Community License，基于 Apache-2.0；开发并分发衍生作品要求商业许可。 | 只作产品参考，不复用源码。 |
| `CherryHQ/cherry-studio` `30840223e0906985746b06805480c14fca706703` | 社区版根 `LICENSE` 是 AGPL-3.0。官方 README 称 Enterprise 为付费产品，源码“Partially released to customers”。 | 社区版只作参考。没有找到可公开核验的 Enterprise 独立官方源码仓库或其许可证，均记为未知，不能推定与社区版相同。 |

## Spike Gate

1. 用 Tauri 2.11.5 做只读单目录 Spike，只开放 `list/read`，不接入受限参考项目的代码。
2. 在 Rust 侧实现产品自己的 grant 与目录句柄层；先证明 symlink、junction/reparse、路径大小写、UNC/device path、ADS、竞态换链和跨用户攻击都失败关闭。
3. 设备密钥使用系统安全存储适配层。Stronghold 仅可作为加密容器候选，不作为 Keychain/Credential Manager 已完成的证据。
4. 更新器只接受 HTTPS 和固定公钥签名；macOS 签名/公证与 Windows 签名必须在真实目标机验证。
5. 在 macOS ARM64 和 Windows x64 完成安装、卸载、自动启动、升级、撤销、离线与重连测试前，保持功能关闭，也不宣传可用。

机器可读的提交、日期、哈希与读取路径见 `evidence/v1/reuse-r0/desktop-license-repos.json`。
