# 开源候选全景

2026-09-18。固定源码的审计清单；源码/测试/Docker/迁移/安全的实际范围见三份 research 文档。未运行上游测试，不将其 CI 或文件数量当作本项目通过。

| Project | Exact commit | Tag | License | Current use |
|---|---|---|---|---|
| assistant-ui | `6cd9226241d7e3f1a89e93f3160baa4f63157f6f` | @assistant-ui/ai-sdk@0.0.6 | MIT | CANDIDATE_R1 |
| tool-ui | `49a870286facdbf28160cd647f0d337ebdc9b275` | 未锁发布标签 | MIT | CANDIDATE_R1 |
| better-auth | `5468e6bfcdff799848537cf5ad06ebab15aad9dd` | v1.7.5 | MIT | CANDIDATE_R1 |
| dashboard | `7705dfc0d13889e45c26a55ad5908da6a7a9a605` | 未锁发布标签 | MIT | CANDIDATE_R1 |
| anything-llm | `da6685510ce691b2e1be417f739c7dffee3cfc49` | v1.16.1 | MIT | REFERENCE |
| librechat | `12d78909d3f5247a8d40a47f0ef5c3ac771d9c5a` | v0.8.8-rc3 | MIT in root LICENSE | REFERENCE |
| onyx-ce | `2931768b33b412e0588268ad1d069012776b2373` | v4.8.0-cloud.2 | Mixed repository: MIT Expat outside named ee directories; Onyx Enterprise License inside ee directories | REFERENCE |
| ragflow | `4b055c5996bbc5649e12ee5a5e7d170dbc58c9e5` | v0.27.2 | Apache-2.0 at repository root; parser candidates also carry Apache-2.0 file headers | REFERENCE |
| Tauri 2 | `7cd71369c00978a3783b6ae3e9972358abbe4ae6` | tauri-v2.11.5 | Apache-2.0 OR MIT | REFERENCE |
| Tauri official plugins | `67cd25a10ce3deb1b935e725228e528766f24ad7` | 未锁发布标签 | Apache-2.0 OR MIT | REFERENCE |
| Wails | `6d919787ca86ecea7db774517d3043da79b319d6` | 未锁发布标签 | MIT | REFERENCE |
| Open WebUI | `0a7c15832fb30b1903753e83f81dc7d27e5b0944` | 未锁发布标签 | custom Open WebUI License with multi-license history | REFERENCE_ONLY |
| Dify | `a81f6fed679d6ad74118845d6137615067ee7345` | 未锁发布标签 | modified Apache-2.0 with additional conditions | REFERENCE_ONLY |
| FastGPT | `8a75e13c4ca0a8e8cb36bb7794f88e2c02ce61ad` | 未锁发布标签 | FastGPT Open Source License based on Apache-2.0 with additional conditions | REFERENCE_ONLY |
| LobeChat | `b0ef4b2ef15d61b0be43bfa6f39d3524405ce374` | 未锁发布标签 | LobeHub Community License based on Apache-2.0 with additional conditions | REFERENCE_ONLY |
| Cherry Studio Community Edition | `30840223e0906985746b06805480c14fca706703` | 未锁发布标签 | AGPL-3.0 | REFERENCE_ONLY |
| Cherry Studio Enterprise | `UNKNOWN` | 未锁发布标签 | UNKNOWN | REFERENCE_ONLY |

源码审查：`research-core.md`、`research-knowledge.md`、`research-desktop-license.md`；机器证据：`evidence/v1/reuse-r0/`。GitHub remote/API 的观察时点与源码提交时间分别保存；不推定 HEAD 等于稳定 release。

补充 UI 审查：LibreChat `client/src/hooks/SSE/useResumableSSE.ts` 深度绑定 Recoil/Jotai、generation protocol、approval 与 data-provider；`useAttachments.ts` 的持久附件与实时状态合并可作为重复/陈旧状态回归参考。AnythingLLM `frontend/src/pages/WorkspaceSettings/index.jsx` 将向量库、成员、Agent 配置绑定自身 Workspace/System API，不能仅换几个 URL 就复用为当前产品后台。
