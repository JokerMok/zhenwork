# Local Bridge 安全设计与交付 Gate

状态：P7 决策为 V1.1，桌面功能尚未实现/打包/验收；V1 默认 `LOCAL_BRIDGE_ENABLED=false`。目标 macOS Apple Silicon / Windows x64；平台未真实打包和攻击通过不得启用。Web 上传下载独立交付。

## 身份、配对和网络

设备主动向 PUBLIC_ORIGIN 建立 WSS/HTTPS 出站连接；服务器不要求员工电脑开放入站端口。桌面进程生成设备密钥，公钥注册；登录员工生成短时一次性配对码，设备与用户双方确认配对。码仅 hash 存库、短有效期、尝试次数受限；配对显示企业域名和设备名，避免误配其他企业。

设备签名请求包含 deviceId、user binding、operationId、递增序列/nonce、expiresAt、参数摘要，服务器去重并检查当前撤销/凭据版本。轮换具有明确过渡窗口且旧 token 到期撤销，禁用用户同时撤销设备；重放不重复写。设备显示在线/断开/撤销，离线操作不静默排队等待未来执行。

## 目录与文件能力

默认无目录权限；必须在本地原生选择器选择具体目录并分别授 read/write。服务器不能替员工添加授权路径；服务器只持 grantId/显示名/权限，不下发任意绝对路径扩大范围。操作只能 list/search/read/create/write/rename/export，禁止 Shell 和动态脚本。

禁止 HOME 根、系统根、.ssh、Keychain、.env、凭据/系统目录及隐含别名；不得因父目录授权自动允许敏感子目录。所有相对路径规范化，拒绝 `..`、absolute/UNC/device path/NUL/alternate data stream；Windows 大小写/保留名/junction/reparse point 也拒绝。只 realpath 前置检查不足以抵抗 TOCTOU，读写需以目录句柄/平台 nofollow 操作保证整次路径解析不出授权目录，无法证明时拒绝功能。

每次操作重新检查目录存在、设备/用户未撤销、grant 未改变、read/write、操作上限及文件类型。目标文件不可是链接，临时文件独占创建，写入前内容摘要/覆盖确认，rename 的两端在同一获授权 grant 内。不跨卷移动，不跟踪 symlink/junction，不提供删除能力。read/search 也受大小/条数限制。

## 审批与隐私

本地首次目录授权、覆盖写、rename、批量导出要求明确确认；审批绑定设备+操作+参数摘要+短有效期，一次性消费，重连不可重放。服务器保存去路径敏感信息的操作审计，设备保存本地近期记录；日志不保存文件正文/真实凭据。撤销在服务器立即生效，设备离线不允许接受新服务端任务；本地用户可单方面断开并清除授权。

若使用 loopback 配对界面，只绑定 127.0.0.1/::1，随机不可预测 token，严格 Origin/Host/配对状态校验，不启用通配 CORS；恶意网页不得通过 CSRF/DNS rebinding 控制本地文件。

## Spike 与放行

1. 协议/威胁模型/flag 关闭测试；模拟设备配对、撤销、nonce 重放与断线。
2. 本地最小只读 Spike：单目录 list/read，验证路径与跨用户攻击；不先实现任意写。
3. macOS/Windows 实际目录句柄安全实现，增加安全写/rename 和审批攻击。
4. 两平台真实构建/安装/卸载/自动启动/升级/凭据保管检查；签名/公证若需付费账号届时提出，不伪造签名。
5. 攻击矩阵、稳定性、离线/重连和包完整性全通过才把 flag 加入受控可启用范围。

RC 前任一关键项缺证据：保持 disabled、UI 不宣传已可用，release notes 列为 1.1。禁止用户仅改环境变量就绕过尚未实现的安全 Gate；服务端需同时具备已验证构建能力标识。

## P7 关闭 Gate（2026-09-19）

本地连接器暂归 V1.1，继续沿用 R0 的 Tauri 优先选型；没有宣称 Tauri/Windows 安全 Spike 已通过，也没有实现第二套桌面框架。V1 配置契约只接受 `localBridgeEnabled:false`，设置 true 启动失败；管理 API 固定报告关闭，配对/读/写入口均为 404。三项实际验证通过，见 `evidence/v1/p7/bridge-disabled.json`。员工仍通过已验收的 Web 上传/下载使用文件。
