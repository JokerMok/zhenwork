import { useTranslation } from 'react-i18next';

const TOOL_NAME_KEYS = {
  Read: 'read',
  read: 'read',
  Write: 'write',
  write: 'write',
  Edit: 'edit',
  edit: 'edit',
  Skill: 'skill',
  skill: 'skill',
  search: 'search',
  Search: 'search',
  Glob: 'search',
  Grep: 'search',
  Bash: 'execute',
  Shell: 'execute',
  Execute: 'execute',
} as const;

export const useToolStepLabels = () => {
  const { t } = useTranslation();
  const displayName = (name: string): string => {
    const key = TOOL_NAME_KEYS[name as keyof typeof TOOL_NAME_KEYS];
    return key ? t(`conversation.toolSteps.${key}`) : name;
  };

  return { t, displayName };
};
