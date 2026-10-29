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
