# 首批行业能力包

四套版本化工作方法：产品选型、固危废政策查询与解读、产废数据分析、资料核查。每套包含受支持的SKILL.md、执行步骤与判断规则、能力定义、Markdown/CSV可编辑模板及共用只读交付校验脚本。日常执行复用当前员工的模型、知识、Office、完整数据计算及任务工具，不创建调度器或行业数据库。

## 安装与升级

在私有配置中提供绑定（不提交到Git）：

```json
{
  "environment": "your-private-company",
  "adminOrigin": "https://your-admin.example",
  "clientId": "your-client-id",
  "modelId": "existing-model-uuid",
  "businessRules": ["existing-published-monthly-rule-uuid"],
  "knowledgeByRole": {"product": [], "policy": [], "analysis": [], "review": []},
  "grantTargets": [{"subjectType": "USER", "subjectId": "explicit-test-employee-id"}]
}
```

知识角色为空时由员工提供当前任务资料或使用已授权知识范围；不得扫描其他目录。生产模型/业务口径必须引用实际配置。没有企业正式口径不能靠行业包填补，测试口径不冒充正式业务。默认只授权指定测试员工；ROLE/DEPARTMENT必须显式设置allowGroupGrant=true，名单与权限仍由服务器校验。本包不注册企业外部连接，也不携带业务资料、账号或密钥。

`node capabilities/industry/install.mjs export BINDINGS.json PRIVATE_OUTPUT_DIR` 生成完整目录，可经后台“企业资源→技能→目录导入”保存、激活和授权；在“助手”配置对应Skill、当前模型和知识依赖。

`node capabilities/industry/install.mjs install BINDINGS.json PRIVATE_ADMIN_AUTH.json PRIVATE_STATE.json` 使用既有资源创建、激活和共享计划/事务API发布四项资源组合。认证文件仅含管理员username/password，必须0600，凭据与会话只在内存/私有文件，不进入行业包、日志或员工配置。不要在命令参数/聊天中粘贴口令。STATE保存资源ID、版本及配置哈希，重复运行复用资源；程序不覆写管理员手工变更，发现漂移明确停止。失败时STATE保留preparing及已完成记录，不宣称四项全部发布，不删除历史数据。敏感依赖一律留在现有后台确认，不自动扩大业务连接范围。

升级时修改相应SKILL语义版本、references/capability.json及catalog.json，保留安装STATE重跑；服务端产生新资源版本并沿当前授权生效。停用、回退Skill版本、撤回共享继续使用现有后台。模型/资料/工具仍逐次复核当前权限，行业包不会复制密钥或让停用资源绕过检查。旧任务原文和成果继续固定来源版本，不由包升级改写。

## 验证边界

共用脚本读取真实下载DOCX/XLSX，核对原生结构、同源元数据及核查清单状态。需要独立核对每条来源和业务判断，不能以脚本通过替代真实网页、法律时效或客户验收。政策索引是复核线索，不是永久法律效力表；运行时须读取官方原文和生效/废止条款。正常员工只选专家或直接描述目标，不配置模型/Skill/MCP，不运行维护脚本。
