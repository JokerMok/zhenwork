# ADR-006 组合 Foundation

状态：ACCEPTED，2026-09-18。R0 6d93df1；R1 317a06e。

决定采用 assistant-ui 包、Better Auth、清理后 dashboard 精选模块、tool-ui 审批卡；不 Full Fork AI 平台。R1 的真实浏览器/PG/Harness 证据证明核心接口可集成。后台模板 Next 版本未照搬，升级到扫描已修复版本；企业权限与动态 ACL 不依赖模板前端过滤。

唯一 Agent Runtime 继续固定 Harness SHA。R1 relay 只是实验桥，生产由正式 BFF/Manager 接管，不能把合成 user_a/b 绑定或 Alpha 长期 bearer 带入生产。

代价：维护少量移植源码的上游路径/修改/哈希；assistant-ui external-store 接口存在版本演进，必须固定版本和运行契约回归。收益：聊天、Markdown、输入、表格、认证和布局不再从头维护。失败与修正见 reuse/spike-report.md。

Next standalone Web、API/WS BFF 分开部署，同源 reverse proxy 统一公开入口。避免 custom Next server 与 standalone 产物的隐式不兼容。Native LGPL 的分发义务留在 P8 制品门禁。
