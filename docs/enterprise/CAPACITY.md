# 容量配置

活跃账号数不等于同时执行任务数。每位员工使用独立运行目录和授权；允许排队，不共享员工执行身份。

| 档位 | 硬件预算建议 | 运行/同时启动/排队 | 状态 |
| --- | --- | --- | --- |
| Small | 4 vCPU、8 GiB RAM、业务磁盘另计 | 2 / 1 / 8 | 待本轮一次五身份实测确认，不作已验证承诺 |
| Standard | 8 vCPU、16 GiB RAM | 4 / 2 / 16 | 按每任务 2 GiB 上限估算，未实测 |
| Large | 16 vCPU、32 GiB RAM | 8 / 2 / 32 | 预算建议，未实测 |

ZW_MAX_CORES、ZW_MAX_STARTING_CORES、ZW_MAX_QUEUED_CORE_STARTS、ZW_CORE_IDLE_MS、ZW_CORE_START_WAIT_MS、ZW_MAX_SESSIONS 分别控制运行上限、启动并发、等待队列、空闲回收、启动等待时限和会话数。模板空闲回收为 30 秒，等待时限为 300 秒。须结合实际耗时、模型额度和队列预算设置。现有 Core 单实例限制 2 GiB/2 CPU，此外还需为数据库、控制端、Host、网关及操作系统预留资源。

发布结论、五任务完成情况和资源曲线写入 ACCEPTANCE.md；表中未实测档位不能销售为保证并发。
