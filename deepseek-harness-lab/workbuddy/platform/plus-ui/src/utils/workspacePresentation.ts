/** Human labels for existing workspace metadata; raw identifiers stay in details. */
const labels: Record<string, string> = {
  ENTERPRISE: '企业',
  PRIVATE: '个人私有',
  SHARED: '定向共享',
  ENTERPRISE_PUBLIC: '企业公开',
  VIEW: '查看',
  USE: '使用',
  EDIT: '编辑草稿',
  USER: '员工',
  ROLE: '角色',
  DEPARTMENT: '部门',
  ALL: '全体员工',
  ASSISTANT: '助手',
  SKILL: '技能',
  TOOL: '工具',
  KNOWLEDGE: '知识库',
  MODEL: '模型',
  MCP: 'MCP',
  ACTIVE: '生效中',
  REVOKED: '已撤回',
  ARCHIVED: '已归档',
  DRAFT: '草稿',
  PENDING: '待审核',
  APPROVED: '已通过',
  REJECTED: '未通过 / 已撤回',
  STARTED: '执行中',
  RUNNING: '运行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  INCOMPLETE: '回执不完整',
  UNKNOWN: '未知',
  ESTIMATED: '估算',
  REPORTED: '供应商已报告',
  VERIFIED: '已验证',
  NOT_TESTED: '尚未测试',
  READY: '可使用',
  PASS: '通过',
  ERROR: '失败',
  QUEUED: '等待处理',
  OK: '正常',
  UP: '正常',
  DOWN: '不可用',
  UNAVAILABLE: '不可用',
  OPENAI_CHAT: 'OpenAI 兼容对话',
  CUSTOM_OPENAI: '自定义 OpenAI 兼容',
  OPENAI: 'OpenAI 兼容',
  ARK: '火山方舟',
  DEEPSEEK: 'DeepSeek 兼容'
};
export function workspaceLabel(value: unknown): string {
  if (value === null || value === undefined) return '未知';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(workspaceLabel).join('、') || '无';
  if (typeof value === 'object') return '结构化详情';
  return labels[String(value)] || String(value);
}
