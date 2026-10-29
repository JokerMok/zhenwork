# 三格式同源交付与可编辑 PPT

本轮沿用 python-pptx、OfficeStore、TaskRunner 和原聊天成果区域。`create_business_presentation` 使用已保存的 analysisId，或从已核验且当前 SHA 与交付回执一致的 Word/Excel 对导入核查结果；模型不重新计算数字。三格式关联原任务/轮次、原始结果哈希、固定文件版本、统计口径、来源、模板和本次执行。历史 Agent partial 状态与实际文件质量分别保留。

## 生成和修改

支持原生标题、副标题、段落、项目符号、指标卡、表格、柱/线/饼图、图片/Logo、来源、页码和备注；图表含可编辑工作簿，不能用整页截图替代。默认月报按概要、分类、车间、真实期间趋势、排除项、限制和来源组织；产品参数和正式条款使用已验证的数据。背景和版本差异不计入正式条款统计。

原 `revise_office_document` 增加 PPT 对象检查与定点操作。修改须提供当前 SHA，写入前再次核对；只修改指定页/对象，并产生新版本。业务事实、来源页和唯一承载事实的页受保护；图表刷新只接受同一可信结果的数据。改变原件应先产生新分析，再重新生成完整 PPT，不能宣称手改 PPT 同步了 Word/Excel。

按文件及 SHA 保存不可变依赖，在上传可见前落盘。预览、下载、继续修改、重用和旧版下载均复核当前权限。Word/Excel 成功而 PPT 失败时返回 partial 及原文件的固定版本回执；重试只补 PPT。

## 企业默认模板

通过现有管理员 Skill 资源上传、版本、激活、共享，名称为 `zhenwork-presentation-template`（可加小写连字符后缀）。不执行 Skill 脚本。伴随文件 `references/presentation.json` 示例：

```json
{"name":"合成模板","version":"1.0.0","default":true,"primary":"19384D","accent":"087F8C","font":"Noto Sans CJK SC","titleSize":30,"bodySize":20,"templatePath":"templates/demo.pptx","logoPath":"templates/logo.png"}
```

资产以 base64 包文件上传，单件至多 1MiB。模板仅限16:9、30页以内的被动 PPTX；图片仅 PNG/JPEG、最多1200万像素。保存时与使用时分别检查 ZIP/XML、大小、路径、宏、活动内容和外部引用。默认候选必须唯一；指定模板无权或失效会报错，不静默回落。无配置使用内置版本1.0.0企业简洁模板。已有成果保存模板名称、版本、资源版本和 SHA，不随模板更新重写。

沿用上传文件的母版、主题和背景；正文、图表、表格由受控版式生成。自定义复杂占位符、动画、SmartArt、视频、OLE、宏和任意外部资源不在本轮支持范围。原生可编辑不代表所有客户端像素一致。

## 预览与资源边界

OfficePreview 以实际文件版本选择幻灯片，按需使用受控 LibreOffice → PDF → PNG 真正渲染。文本/表格/图表转录仅作辅助可访问内容。无常驻转换服务、无第三方文件传输、无跨版本图像缓存。

生成输入2MiB、输出10MiB、最多30页，单 Host PPT 生成并行1，Python384MiB/CPU18秒/总20秒。预览沿用全局单转换门禁，LibreOffice1GiB虚拟内存/CPU25秒/总32秒，临时输出64MiB、PDF20MiB、单图4MiB；使用独立禁宏配置和进程组超时终止。压缩包最多4000项、解压80MiB、单项20MiB。主机需 `libreoffice-impress-nogui`、`pdftoppm` 和 CJK 字体，Python沿用现有 Office venv。

## 定向验收

本轮只检查受影响生成、版本、权限和预览链路；未变管理网页、监控、Core/Gateway 镜像及24迁移复用。受影响 Java 仅增加模板保存校验。真实员工、公网模型、实际文件和 Office 编辑证据及部署结果在本轮验收记录中更新；构建或 ZIP 结构正常不等于业务验收。WPS/Microsoft PowerPoint 未安装时，不以 LibreOffice 的结果代替其兼容性结论。

## 2026-10-29 实际发布与验收

应用 `20261029-presentation-delivery-v4` / `aba95a435c1b4fa3b3e1dc80f4310f823c393e56`。真实普通员工公网模型生成8页月报、10页核查、12页选型及自定义模板PPT；独立读取三格式关键数据、来源与固定版本一致。月报2150kg/A1350/B800/3条/口径v2；核查正式5项/20%、Q03部分符合且遮蔽待确认；IP54/IP65、资料版本与缺失认证保留。

当前月报v6、全部6版本保留，真实网页完成恢复初版/再恢复修订版。最终标题修改仅改变指定页及修订审计，其他图表、工作簿和来源不变。原聊天三格式回执、真实分页预览及浏览器下载SHA通过。模板资源v1→v2/主题1.1.0后新文件使用当前默认，历史模板/PPT不重写。LibreOffice26.2.6.3实际编辑、保存和重开标题/表格/图表显示通过；不替代WPS/Microsoft PowerPoint或真实品牌验收。

关闭浏览器继续、取消无虚假完成、第二账号13项拒绝、口径/知识撤权及恢复、失败只补PPT通过。文件有效与模型状态分开：初次续改缺回执partial、产品上游失败partial、自定义核查interrupted保留；后续新续改轮次completed。

最后回执修复适配原聊天outputs协议，保留TaskRunner files结构；完整/部分失败输出由同份真实版本回执生成。受影响链初始68通过/5跳过，最后21项重跑及Java模板3项通过；Host3项原有类型诊断保留，无新增，不宣称完整类型检查通过。未跑全系统。第三轮六份Word/Excel、8资源/模型/知识/Skill保持。

最后只重建Host，Web/Java/Admin/监控/native与24迁移按manifest复用，预算Core1不变。当前previous为industry-quality-v2；旧Host不具PPT来源门禁，回退应先停用模板/隔离员工入口并收敛在途，保留数据，只在补齐门禁和复验后开放。仅完成兼容审核，未实际回滚。私有报告 `.codex/presentation-delivery/acceptance-report.md`，服务器 `shared/config/acceptance/20261029-presentation-delivery.md`。第四轮CONDITIONAL GO并收口。
