# P8 部署与运维验收

日期：2026-09-20。当前范围是 macOS 上的 Docker Linux ARM64 和本机 AMD64 交叉构建；真实 Linux AMD64 服务器尚未验收。

## 已实现与验证

部署复用 Docker Compose、PostgreSQL 17、Caddy，新增服务镜像、固定镜像 digest、安装和运维脚本。只有统一入口发布端口。BFF 没有 Docker socket；只有 Manager 持有 socket；Provider Secret 只挂载 Gateway。Node 服务和入口以部署用户 UID/GID 运行，根文件系统只读、移除 capabilities，设置内存、PID 和日志轮转上限。数据库保留标准 PostgreSQL 启动方式。Docker 管理权限属于可信管理面，不是员工权限。

生产配置要求 HTTPS。Mac 验收使用 Caddy 内部 CA，客户端显式信任该 CA，没有关闭 TLS 校验。生产域名使用 Caddy 正常证书签发。初始化写入随机秘密和引导管理员密码到 0600 文件，不在日志打印。初始化要求非 root 部署用户；Linux 自动取 Docker socket 的 GID，也可显式配置。

AES-256-GCM 加密备份覆盖数据库、业务文件、各用户 Runtime 的工作区和会话卷，以及恢复所需应用密钥；Provider Secret 不进入备份，恢复时由部署管理员另行提供。备份密钥单独保存。备份先暂停本实例入口和执行，记录审计链锚点及载荷 SHA256，完成后恢复原来运行的服务。恢复只接受空数据库和不同部署命名空间，先认证密文再写数据，保留既有环境。

实际演练创建合成员工、部门、品牌、知识 ACL、私人文件和真实模型会话，随后加密备份并恢复到新实例。恢复后验证用户、部门、品牌、知识权限、私人文件原始字节、跨用户 404、审计链和原有 `recover.txt` 的真实 Harness 读取。另已完成 6 → 7 数据库迁移升级；禁止跨 schema 的直接镜像回退，改由升级前加密备份恢复到独立命名空间，再次核对数据和模型会话。

## 测试证据

| 测试 | 结果 | 证据 |
|---|---|---|
| 最终 ARM64 Compose：HTTPS、持久数据、真实模型、附件类型和隔离边界 | 5/5 PASS | `evidence/v1/p8/compose-final.json` |
| 最终镜像真实模型读写、审批拒绝/通过及跨用户拦截 | 3/3 PASS | `tool-lifecycle-final.json` |
| 最终镜像工作法、附件、知识检索、目录查询、导出与在途撤权 | 4/4 PASS | `knowledge-runtime-final.json` |
| 最终 ARM64 安全回归 | 98/98 与 2 项 hardlink PASS | `security-final.json` |
| 最终镜像升级与回滚，含真实模型和 digest 核对 | 4/4 PASS | `update-roundtrip-final.json` |
| 最终镜像加密恢复、审计锚点与原会话文件读取 | 3/3 PASS | `restore-final-acceptance.json` |
| 篡改 GCM、覆盖非空库 | 2/2 正确拒绝 | `backup-negative-final.json` |
| migration 6 → 7（较早部署证据） | PASS | `upgrade.json` |
| 跨 schema 直接回退（较早部署证据） | 正确拒绝 | `rollback-refused.stderr` |
| 升级前备份重建（较早部署证据） | PASS | `rollback-restore.json`、`rollback-acceptance.json` |
| 最终镜像 20 个请求同时提交，执行池上限 4 | 20/20 PASS；p50 26.955s、p95 46.723s | `capacity-final.json` |
| 当前 Node24 单元测试 | 21/21 PASS | `unit-final-node24.log` |
| 当前 lint、服务及 Web 类型检查 | PASS | `lint-final.log`、`typecheck-final-services.log`、`typecheck-final-web.log` |
| 最终 ARM64 镜像权限和 CLI/Sharp | PASS | `runtime-arm64-policy.json`、`runtime-arm64-final-smoke.json` |
| 最终 ARM64 整镜像扫描与漏洞处置 | 限定 Runtime 权限下缓解通过；原始发现未抹除 | `image-security-review-arm64.json`、`image-scan-arm64/` |

表内无完整路径的证据均位于 `evidence/v1/p8/`。容量耗时包含排队和模型服务时间，不是纯平台延迟。首次容量测试 6/20 成功：Docker 默认网络池耗尽导致余下请求失败。修复为部署独立 `/28` 子网分配并检测重叠后重测 20/20；原失败保留在 `capacity-initial.json`。资源配置不因测试通过自动扩大。

最终升级演练首次遇到一次 ProviderError，原始失败保留在 `update-roundtrip-provider-failure.json`。随后模型探测成功，完整升级和回滚重跑 4/4 通过；连接失败的确切原因尚未确认。附件验收首次误把 PNG 当作支持类型，服务按既定范围返回 415；已修正为类型拒绝测试，未扩大附件支持范围。

双架构最终扫描中，Runtime 仍有 43 条 HIGH 原始发现（8 个不同 CVE），PostgreSQL 的 gosu 仍有 1 条 CRITICAL、21 条 HIGH 元数据发现。Runtime 采用 3 项受影响组件排除和 5 项运行权限缓解，后者不等于修复系统包。对实际 gosu 二进制执行 govulncheck，覆盖上述 22 项 CVE，未发现对应函数符号；这不等于升级编译器，也不能泛化为任意构建无漏洞。六个控制服务镜像无 HIGH/CRITICAL。详见 ADR-007 及按镜像 digest 绑定的审查记录。

## 未完成的发布 Gate

20 个 Runtime 同时活跃、持续 10 分钟、至少三轮的 64 GiB 服务器负载目标尚未执行；8 GiB 本机排队结果不能替代。真实 Linux AMD64 干净安装、独立设备与真实用户 UAT 均需外部条件。所有最终镜像的漏洞、SBOM、分发许可与原生模块验证必须与候选 digest 对齐，不能用较早镜像的 PASS 代替。

源码包已补齐 Sharp/libvips 原生依赖、补丁和 librsvg 的 350 个 Cargo 归档，见 `native-source-bundle.json` 及 `native-library-replacement.md`；整套镜像（含操作系统、Harness 依赖）的分发闭环单独核验，未核验部分不得标为合规完成。

## 最终镜像打包修订

完整开发依赖中发现本产品未启用的 `@anthropic-ai/claude-agent-sdk` 0.3.263，许可字段指向额外条款。最终 Runtime 改为多阶段构建，在最后镜像复制前排除未启用的 Claude Agent SDK、Codex CLI、CUA Driver 和上游 LibreOffice Kit 及对应平台包，并省去 C/C++ 编译工具链。排除清单位于镜像 `/opt/harness/workbuddy-image-exclusions.json`。不能通过在单阶段镜像后续层删除来声称二进制已经从分发物中移除。

该操作只作用于可丢弃的镜像构建树，没有修改官方 checkout、Core、Agent Loop、锁文件或 SDK 协议。所有产品执行继续通过 Harness SDK 和外置 bridge。最终镜像必须重新验证实际会话、工具、文件与安全回归，删除依赖本身不算通过。

构建保留原始上游锁文件及哈希；临时 workspace 与 lock 同步追加排除元数据，派生 lock 仅移除 25 个相应可选引用；实际解析对比证明 package resolutions、importers 和其他引用不变，再执行 frozen 安装。已实测全局配置被忽略、仅修改 workspace 导致锁校验失败，原证据均保留。生产依赖图裁剪、四个第三方依赖的独立安全修补锁，以及入口重建范围见 ADR-007。所有结果以最终镜像实测为准。

双架构最终构建均已完成，每架构 8 个镜像；Runtime CLI/Sharp、Web Sharp 转换和权限检查通过，证据分别为 `runtime-{arch}-final-smoke.json`、`web-{arch}-native-final.json`、`runtime-{arch}-policy.json`。两架构均完成原始漏洞扫描、CycloneDX SBOM 和按 digest 绑定的限定权限审查。AMD64 Server 首次 npm 下载 ECONNRESET、PostgreSQL 首次拉取停滞的记录已保留；同配方重试成功，没有关闭 TLS 校验。AMD64 结果仍属于本机交叉构建及执行，非真实服务器验收。
