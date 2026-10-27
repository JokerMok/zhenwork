export const errorCode: any = {
  '401': '认证失败，无法访问系统资源',
  '403': '当前操作没有权限',
  '404': '访问资源不存在',
  ShareTargetUnavailable: '共享对象已停用或不存在，请重新选择',
  ShareTargetTooLarge: '对象范围超过校验上限，请缩小范围后重试',
  ShareSearchTooShort: '请填写2至80个字符进行搜索',
  InvalidShareSearch: '搜索条件不正确，请重新输入',
  InvalidShareSubject: '共享对象类型不支持，请重新选择',
  InvalidShareActions: '请选择有效的共享权限，使用和编辑均须包含查看',
  ShareDependenciesUnavailable: '依赖授权或可用状态已变化，请重新检查共享对象和依赖',
  SharePlanChanged: '配置或授权已变更，请重新检查并确认共享范围',
  SensitiveDependencyConfirmationRequired: '请确认所需追加权限后重试',
  IdempotencyConflict: '同一请求的内容已变更，请重新选择后提交',
  ResourceUnavailable: '资源已停用或未激活，请先检查资源状态',
  InvalidResourceDependencies: '资源依赖配置不完整，请先检查模型及能力绑定',
  ActivateBeforeSharing: '请先激活资源版本，再设置共享',
  OwnerSharingRequired: '只有资源所有者可以设置共享',
  default: '系统未知错误，请反馈给管理员'
};
export default errorCode;
