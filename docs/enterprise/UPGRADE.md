# 升级与应用回退

应用回退只切换程序版本，不将数据库降级。Data restore 使用已验证的加密备份恢复数据，会回到备份时点；两者不能互相替代。

RC1 的 upgrade.sh 仅接收 schemaCompatibility 一致、24 项迁移名称和 SHA 完全一致、应用/运行目录字节及原生二进制不变的非破坏性元数据候选包。组件更新或新增迁移必须走另行审查的发布流程，不接受跳过兼容门禁的强制回退。

1. 通知维护、收敛在途任务，检查版本和磁盘。
2. 执行并妥善保存正式备份；校验候选包 SHA256SUMS。
3. 执行 `sudo bash deploy/enterprise/upgrade.sh /root/enterprise.env upgrade /path/to/reviewed-candidate`。
4. 检查健康、企业资源、旧会话/文件和个人方法，记录候选配置是否生效。
5. 需要回退时执行 `sudo bash deploy/enterprise/upgrade.sh /root/enterprise.env rollback /path/to/original-rc1`，再核对原版本和旧数据。失败时保持维护，禁止猜测数据库降级。

脚本不会重新安装行业包或覆盖员工副本，也不删除历史 release 目录。RC1→候选→RC1 的实际演练结果见 ACCEPTANCE.md。
