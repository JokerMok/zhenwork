# RC1 → RC2 性能对照

性能目标是验收标准，不是已通过结果。普通点击视觉反馈 <=200ms；常用页可交互 P95 <=1.5s；普通 List/Config API P95 <=500ms；消息本地显示与 Processing <=300ms。

在 RC1 产品代码修改前，以冻结镜像、当前 Mac、同一模型、专用合成员工与管理员采样 localhost 和现有 Quick Tunnel。脚本 `scripts/rc2/rc1-performance.mjs` 为每个普通 API 和员工页面导航各执行 30 次，保存全部样本、P50/P95、错误率、缓存方式与环境。AI 分别测冷、热 Runtime；只停止专用 benchmark 员工容器，不影响其他员工。两种传输顺序相同，聊天新增数据需记录在对照中，不能称数据绝对不变。

原始结果 `evidence/v1/rc2/r1/performance/baseline.json`。内部细分缺 instrumentation 的字段为 null；真实 UI 与请求/完成时间单独记录，不能将 Provider 等待等同平台 API 时间。只有两种传输均采样完成才能称基线测量完成。

RC2 使用相同脚本方法、提示词摘要、模型和数据量重测，记录配置变化。新增 tracing 实测 UI response、API enqueue、Runtime acquire/warmup、Gateway request、Provider TTFB、Model first token、First visible token 和 Total completion；浏览器耗时与服务耗时分别计时，避免跨机器时钟相减。冷/热样本不混合；AI 单次样本不能推断 P95。

Admin 路由和大模块懒加载，Employee Chat shell 先渲染，资源/历史懒加载。列表、审计与用量分页并检查索引；Loading/Empty/Error/Success 区分。任何优化需通过同条件比较证明，不为性能共享多个用户的 Runtime。
