# ADR-001 独立控制面与固定 Harness

状态：采用。背景：现有 32 个源码/测试/配置/报告文件组成 Alpha，产品无 Git；官方 Harness 另有干净仓库。决定：在 workbuddy 建独立仓库和 TS 控制面，冻结 Alpha 基线，不一次重写 Agent Loop，不改上游。产品 BFF 模块化单体，admin 逻辑隔离；Docker 权限由独立 Manager 持有。原因：保留已验证能力，同时切断 Web 服务的 daemon 权限。代价：维护 stdio 契约及跨服务认证，必须为 crash/并发/超时补测试。否决：直接暴露 Harness Web、在 BFF 挂 socket、复制 Core 后随意改动。撤销：可回到冻结 Alpha 作本地验证，但不能把 Alpha 当生产回滚版本。
