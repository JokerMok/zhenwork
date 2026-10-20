# 服务器目录同步到现有企业知识库

`knowledge_directory_sync.py` 只处理一个显式配置的只读源目录，通过现有 RC2 登录、知识文档上传/版本更新和撤回 API 同步到已存在的知识库。它不创建知识库，不修改目标知识库 ACL，也不扫描配置外的目录。

该脚本只支持 Linux，并要求 `/proc/self/fd` 可用。扫描和上传都先以 `O_NOFOLLOW` 打开文件，再通过文件描述符核对已打开对象的真实路径、类型、硬链接数、大小、哈希及读取前后元数据；因此员工可写目录中的中间目录替换或符号链接竞态不会退化为普通路径读取。缺少文件描述符路径能力时脚本直接失败。

将 `knowledge-directory-sync.example.json` 复制到 root 管理的私有配置目录，填写真实 `sourceRoot` 和目标 `knowledgeId`，然后设为 `0600`。未配置真实目录时脚本直接拒绝运行。配置中必须显式给出：

- 只读源目录、目标知识库 UUID、允许扩展名。
- 文件数、单文件字节数、总字节数、目录数和嵌套深度上限。
- `sourceReadonly: true`、状态文件路径和凭据文件路径。
- HTTPS Native RC2 API 地址和服务器允许的 HTTPS `Origin`。本项目的 Native API 示例是 `https://zhenwork-admin.shizibandu.icu/api`，请求 `Origin` 是 `https://zhenwork.shizibandu.icu`；两个入口不同是当前网关架构要求。
- `allowRetract`；默认应为 `false`。

凭据文件由 root 拥有且权限必须恰为 `0600`，内容只允许：

```json
{"clientId":"已授权客户端ID","username":"已授权账号","password":"由私密配置系统写入的密码"}
```

仓库不提供默认账号或密码。脚本不把凭据、Cookie 或文档内容写入日志；标准输出只包含各类操作计数。使用的账号必须已经拥有目标知识库的 `EDIT` 权限，权限由现有 API 再次校验。

此脚本不会自行安装服务、定时器或目录监听，也不应默认指向任意共享目录。管理员应先选定单一目录、设置容量边界和允许扩展名，再以私有配置显式启用。

## 安装或更新工具

在任意本地仓库副本的根目录运行以下命令，可重复安装或更新 `tencent-main` 上的脚本、README 和示例模板：

```bash
bash scripts/rc2/install_knowledge_directory_sync_remote.sh tencent-main
```

远程入口只打包本目录中固定列出的安装器、同步脚本、README 和示例模板，上传到服务器新建的 `/tmp` 临时目录，再通过 `sudo` 执行 Linux 安装器；结束后只删除该次临时目录。服务器安装器拒绝在非 Linux 系统运行，固定写入 `/srv/apps/zhenwork/tools/knowledge-directory/`，目录及脚本为 `root:root 0755`，README 为 `0644`，示例模板为 `0600`。它不读取或覆盖 `/srv/apps/zhenwork/shared/config/knowledge-directory-sync.json`、凭据文件或状态文件，也不创建服务、定时器或真实共享目录配置。示例模板始终只是模板，不能直接视为启用配置。

```bash
python3 scripts/rc2/knowledge_directory_sync.py \
  --config /srv/apps/zhenwork/shared/config/knowledge-directory-sync.json
```

服务器安装路径下的实际命令为：

```bash
sudo python3 /srv/apps/zhenwork/tools/knowledge-directory/knowledge_directory_sync.py \
  --config /srv/apps/zhenwork/shared/config/knowledge-directory-sync.json
```

只有管理员明确创建上述私有配置并填写真实目录后才可运行；安装工具或模板本身不会启用同步。

每个文件以 SHA-256 判断是否变化。首次上传建立远程文档；哈希不变时跳过；哈希改变时使用 `documentId + expectedVersion` 生成新版本。只有 API 成功返回后才会以原子替换方式推进对应文件的本地状态；失败的文件不推进哈希或版本。

本地文件消失时默认保留远程文档。撤回必须同时满足两个条件：私有配置中 `allowRetract: true`，且当次命令显式传入 `--retract-missing`。撤回仍调用原 `DELETE /ai/knowledge/documents/{id}` 权限 API。

源目录本身或目录内任意符号链接都会被拒绝；非普通文件、硬链接、realpath 越界、扫描期间变化、文件同名冲突、远程版本漂移以及非法或损坏的本地状态也会失败关闭。目标知识库的原 ACL 决定同步资料的最终访问范围；脚本不调用分享或广泛授权 API。
