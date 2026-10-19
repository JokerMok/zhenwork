# 开源许可边界

2026-09-18；这是按固定源码和路径进行的工程许可核查，不把根许可证推定到所有子目录。候选只在 gitignored `.research` 中；精确版本、许可证摘要和源码路径见 JSON 证据与 `third-party-lock.json`。

- assistant-ui / tool-ui：MIT，包优先；移植 tool-ui 时保留 AgentbaseAI 版权及 MIT 全文。
- Better Auth：MIT，采用包；遵循其最新受支持版本安全策略。许可证通过不等于漏洞扫描通过。
- Kiranism dashboard：MIT，移植清理后组件时保留 Kiranism 版权、源 SHA、路径和修改记录。
- AnythingLLM：MIT，当前 REFERENCE，不移植整套 Agent。
- LibreChat：根 LICENSE 为 MIT、package 元数据存在 ISC 差异；当前只 REFERENCE。任何移植前按具体文件消除差异。
- Onyx：仅可考虑 MIT CE；`backend/ee/**`、`web/src/app/ee/**`、`web/src/ee/**` 一律禁止导入、复制、依赖。路径扫描作为后续 release gate。
- RAGFlow：根 Apache-2.0；若使用具体解析器须保留文件头及适用 NOTICE、登记修改；依赖许可另审，不因根 Apache 覆盖模型或其他资产。
- Tauri/Wails 与限制型项目：具体结果见 `research-desktop-license.md`。Local Bridge 尚未引入。Open WebUI、Dify、FastGPT、LobeHub/LobeChat、Cherry Studio 默认只 REFERENCE，不复制白标受限代码。

新增 dependency、复制文件、vendor module 时更新锁定清单。包依赖以 npm lock 的 integrity 和许可证清单追踪；移植以原始和最终 SHA256 追踪。Unknown、enterprise-only、branding/commercial 限制未消除时不得进入发布包。发布前还需 SBOM、完整依赖许可证扫描和人工处理未分类项，R0 静态审查不能替代它们。
