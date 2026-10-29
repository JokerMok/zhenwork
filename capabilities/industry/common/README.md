# 共用交付检查

`validate_result.py WORD.docx EXCEL.xlsx [--expected expected.json]` 只读检查实际文件、同源追溯及核查状态完整性；expected 可提供 `requiredText` 字符串数组。只依赖 Python 标准库，有大小及展开预算，不联网、不写文件、不执行文档宏或公式。每个 Skill 安装/导出时完整带入脚本和说明，避免四份实现分叉。

日常员工使用既有受控 Office 工具，不需要运行此脚本或批准本地命令。此脚本用于管理员维护/验收，可在下载成果后独立执行；不能代替来源内容、专业判断、真实网页及权限验收。
