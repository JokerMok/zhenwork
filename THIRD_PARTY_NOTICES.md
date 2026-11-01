# ZhenWork Enterprise：第三方组件与再分发边界

本文件是发行清单索引，不向未获授权的集成代码授予新许可。实际二进制包须同时附带 licenses/ 的许可证文本、依赖版本清单及来源记录。尚未完成的许可核查不得标记为通过。

| 组件 | 来源与固定版本依据 | 许可 |
| --- | --- | --- |
| AionUI | iOfficeAI/AionUi；仓库 SOURCE_PROVENANCE.json 与应用构建来源清单 | Apache-2.0，保留本地修改说明和版权 |
| AionCore / aionrs | iOfficeAI/AionCore、iOfficeAI/aionrs；随源快照及 Cargo.lock | Apache-2.0；依赖分别适用其自身许可 |
| RuoYi-Vue-Plus / plus-ui | dromara/RuoYi-Vue-Plus、CrazyLionCat/plus-ui；源快照及锁文件 | MIT |
| Legacy Harness / WorkBuddy 集成来源部分 | deepseek-ai/deepseek-harness；原 third-party/licenses/deepseek-harness-MIT.txt | 原 MIT 声明保留；不声称与腾讯 WorkBuddy 存在关联 |
| WorkBuddy Finance Workbench | feng-liu-1994/workbuddy-finance-workbench，2.7.0，提交 5689d65599357e50a814622640ace1656b45799e | MIT；完整复用 finance-workbench 子树，31 项原文件指纹见标准包 references/source-manifest.json |
| openpyxl / python-docx / python-pptx / XlsxWriter | 运行镜像 Python 元数据中的实际版本 | MIT；许可证文本须随包保留 |
| OfficeCLI | OfficeCLI.AI / goworm；已验收 Linux x64 二进制及构建指纹 | Apache-2.0，保留 LICENSE 和 NOTICE |
| Node.js / uv | nodejs.org / astral-sh/uv；运行包实际版本 | Node.js MIT 与附带第三方声明；uv MIT/Apache-2.0，按原包保留 |
| PostgreSQL | 官方 postgres:17-alpine；镜像固定指纹 | PostgreSQL License，基础系统依赖另列 |
| Redis | Ubuntu 26.04 软件包实际版本及源码包 | 8.x 可能含 AGPLv3/RSAL/SSPL 多许可，必须按所选许可履行义务；在线安装配方不等于可无条件转售预制镜像 |
| Linux/Python/Java 与其他库 | 发行镜像 dpkg、Python dist-info、Jar/Maven、npm、Cargo 锁定版本清单 | 按实际组件许可；涉及源码提供义务须一并履行 |

## 明确排除

原 AionCore 内置 PDF Skill 带有禁止向第三方再分发的限制许可。RC 标准源树已移除该目录，必须重新构建原生二进制，不能从旧 Core 镜像继承含该材料的下层，也不能只删除运行时展开目录。旧试点镜像不属于新的客户发行包。

不随包分发许可证不明的非核心插件；管理员可在自己的授权范围内后续安装。模型服务、企业 API 及连接凭据不随包交付。

## 商业交付状态

本项目原有未统一许可的集成代码没有被本轮擅自改授 MIT/Apache。交付前须由权利人和客户的适用协议覆盖该部分。最终许可与安全状态见 docs/enterprise/ACCEPTANCE.md；未完成实际依赖核查的候选包不得用于正式再分发。
