# 企业管理员手册

先阅读 PRODUCT.md。交付状态以 ACCEPTANCE.md 为准，不把启动成功当作业务验收。

## 安装与初始化

标准环境为 Ubuntu 26.04 LTS x86_64、systemd、Docker，两个独立 HTTPS 域名。DNS 指向服务器，开放 443；自动申请证书还需按所用 ACME 方式放行验证。内部端口只监听本机。准备至少 30 GiB 应用空间，业务文件和备份另作预算；磁盘不足时先扩容，不删除有效文件。

1. 校验发行目录的 SHA256SUMS，再以 root 将配置模板复制为 /root/enterprise.env，设为 0600。设置独立 ZW_ROOT、ZW_INSTANCE、两个入口和离线保管的备份密钥路径。
2. 执行 `sudo bash deploy/enterprise/install.sh /root/enterprise.env`。缺少基础软件时，安装器仅在支持的 Ubuntu 版本安装所需系统包。镜像按 NATIVE_IMAGES.json 固定指纹使用；在线构建见发行包 runtime/README.md。
3. 管理员随机初始密码在安装器给出的本机 0600 文件中，不在网页、控制台或包内公开。登录后设置个人密码，妥善保管恢复密钥。
4. 管理端配置企业名称/Logo、Provider 密钥、默认模型、部门/角色和员工。模型密钥仅进入现有后端安全配置。员工首次登录须修改初始密码。
5. 创建并发布本企业业务口径；知识和连接使用本企业资料与凭据。用 bootstrap-enterprise.mjs 安装现有标准包并重新绑定本企业资源。示例 setup JSON 见下；企业标识、资源 ID 均由本次后台生成。

```json
{"root":"/opt/zhenwork","origin":"https://work.example.com","controlPort":18883,"environment":"customer-private","companyName":"企业名称","employees":[{"username":"employee-a","name":"员工甲"}],"provider":"/root/private-provider.json","businessRuleId":"后台新建并发布的资源ID","knowledgeByRole":{},"methodConfiguration":{"company":"/root/company.json","preferences":"/root/preferences.json"}}
```

将上述配置和 Provider 输入均设为 0600；执行 `sudo /opt/zhenwork/current/runtime/node/bin/node deploy/enterprise/bootstrap-enterprise.mjs /root/setup.json`。Provider 文件包含 providerType、baseUrl、code、secret，可附 protocol/contextWindow/maxOutputTokens。若已在后台配置，使用 modelId 替代 provider。company/preference 配置使用本企业口径和字段；演示企业可显式选择 examples/demo-enterprise 下的对应文件。脚本通过现有 API 初始化，不复制其他企业安装状态，也不覆盖个人方法。

## 日常与授权

后台查看用户、部门/角色和数据范围；资源页配置模型、Skill、MCP、知识与专家。共享前检查依赖计划，只授予工作所需的 VIEW/USE；撤回后复查员工入口。模型问题查看 Provider 测试结果，任务和用量查看审计。演示资料只放“示例资料/演示企业”，真实资料放独立授权目录。

## 运维入口

`sudo bash deploy/enterprise/manage.sh /root/enterprise.env status` 查看本实例服务；将 status 换成 start/stop/restart/logs/health 完成相应操作。日志包含业务信息，仅限管理员读取，提交支持工单前脱敏。备份、恢复和升级见 BACKUP_RESTORE.md、UPGRADE.md。

## 常见故障

| 用户现象 | 检查位置 | 处理 |
| --- | --- | --- |
| 模型不可用 | 后台模型测试、Provider 状态、用量 | 检查本企业密钥、网络和额度；修复后继续原任务 |
| 任务启动失败 | 本实例 web 日志、Docker 状态、磁盘 | 检查镜像指纹、运行目录权限和可用内存；不共用员工运行目录 |
| 正在排队或队列满 | 容量配置与运行状态 | 等待已有任务释放；结合实测容量调整，不只提高上限 |
| 磁盘不足 | df、业务文件与备份保留策略 | 扩容或按审批归档；不直接清理历史成果/有效版本 |
| 企业连接失败 | 连接配置、当前授权、远端状态 | 核对本企业连接与权限，不改用其他公司凭据 |
| 文件解析失败 | 原文件、解析提示与版本 | 修复损坏/加密文件或补充支持格式，保留原件 |
| 员工无法登录 | 用户状态、角色、密码策略、审计 | 确认账号状态和入口；走现有重置流程，不启用测试账号 |
