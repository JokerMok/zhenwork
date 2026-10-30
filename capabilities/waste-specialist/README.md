# 企业固危废数据专员标准能力包 v1.1.0

完整复用 MIT 上游 finance-workbench Skill 子树；固定2.7.0 / 5689d65599357e50a814622640ace1656b45799e。未迁入财务UI、DSH侧栏、MCP打开界面、数据库、账号或备份系统。

- `SKILL.md`：适配现有SKILL_PACKAGE_V1；原入口归档在references/upstream-skill.md。
- `references/`、`templates/`：保留所有上游文件原字节，附加行业方法、企业配置和个人偏好。
- `scripts/process_records.py`：仅补行业事件/勾稽/合同计算及可配置强度/费用比较；Python标准库，stdin/stdout，无目录/网络/文件写入。XLSX读取使用平台已有openpyxl有界解析，不另装依赖。
- `examples/`：完全虚构、连续两个月同组业务JSON/XLSX、合同与附件、独立参考式；不含客户资料。不存在的示例附件故意缺失。
- `bundle.mjs`：构建完整资源输入，企业绑定通过实际已授权口径UUID传入。`references/source-manifest.json`列完整来源和文件指纹。

现有MCP仅复用实际工具目录；本场景业务API与申报API未配置，不绑定其他公司的测试接口。上游MCP只有show_finance_workbench显示UI，无对账执行方法，故不安装。

个人编辑路径：工作台→能力→技能→查看→复制为个人方法→选择文件修改→保存并发布→使用。组织只读资源不被编辑，私有版本保留来源资源/源版本/源配置指纹；标准资源升级不回写个人副本。改脚本不等于获得执行授权。

首次真实企业适配：替换主数据/合同/资料要求、保存字段映射与有效业务口径、在现有凭据和连接页面配置接口。缺少单位/车次/税费/证据明确待核。内部容量/账龄不是统一法定期限；无已核实地区和时点依据不自动判断合规。

本次增量：在原六类方法上追加产废强度与变化、处置费用变化分解；直接读取已授权的已有规范结果，不重算旧账。工作方法见 references/analysis-methods.md，追加的模拟资料见 examples/comparison/；上游18/16/20三个方法及31个原文件保持原字节。

个人副本的 references/company.json.analysis 调整表名、字段、单位和对象对应；references/preferences.json.analysis 调整 periods、groupBy、costGroupBy、costDateField、展示重量单位、阈值、精度和输出偏好。可选费用分组缺归属时保留未归属组，不能按产量自动分摊。默认一份必要Excel和聊天结论，Word/PPT仅在明确要求时生成。
