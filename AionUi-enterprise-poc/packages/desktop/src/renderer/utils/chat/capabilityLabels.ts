import type { SlashCommandItem } from '@/common/chat/slash/types';
import type { TFunction } from 'i18next';

const SKILL_KEYS = {
  'enterprise-succinct': 'enterpriseSuccinct',
  'aionui-config': 'aionuiConfig',
  'conversation-create': 'conversationCreate',
  cron: 'cron',
  officecli: 'officecli',
  'session-message': 'sessionMessage',
  'skill-creator': 'skillCreator',
  'story-roleplay': 'storyRoleplay',
  'weixin-file-send': 'weixinFileSend',
} as const;

const MCP_KEYS = {
  'rc2-enterprise-catalog': 'enterpriseCatalog',
  'chrome-devtools': 'chromeDevtools',
  'aionui-browser': 'aionuiBrowser',
  'aionui-image-generation': 'aionuiImageGeneration',
} as const;

const COMMAND_KEYS = {
  open: 'open',
  copy: 'copy',
  compact: 'compact',
  context: 'context',
  clear: 'clear',
  help: 'help',
  quit: 'quit',
} as const;

export const skillDisplayName = (name: string, t: TFunction): string => {
  const key = SKILL_KEYS[name as keyof typeof SKILL_KEYS];
  return key ? t(`guid.skillNames.${key}`, { defaultValue: name }) : name;
};

export const skillDisplayDescription = (name: string, description: string, t: TFunction): string => {
  const key = SKILL_KEYS[name as keyof typeof SKILL_KEYS];
  if (key) return t(`guid.skillDescriptions.${key}`, { defaultValue: description });
  return /^[ -~]*$/.test(description) ? t('guid.skillDescriptionFallback') : description;
};

export const mcpDisplayName = (name: string, t: TFunction): string => {
  const key = MCP_KEYS[name as keyof typeof MCP_KEYS];
  return key ? t(`guid.mcpNames.${key}`, { defaultValue: name }) : name;
};

export const slashCommandDisplay = (
  command: SlashCommandItem,
  t: TFunction,
  isChinese: boolean
): { label: string; description: string; localized: boolean } => {
  if (!isChinese) return { label: `/${command.name}`, description: command.description, localized: false };

  if (command.source === 'skill') {
    const label = skillDisplayName(command.name, t);
    return {
      label: label === command.name ? `/${command.name}` : label,
      description: skillDisplayDescription(command.name, command.description, t),
      localized: label !== command.name,
    };
  }

  const key = COMMAND_KEYS[command.name as keyof typeof COMMAND_KEYS];
  if (key) {
    return {
      label: t(`guid.commandNames.${key}`),
      description: t(`guid.commandDescriptions.${key}`),
      localized: true,
    };
  }

  return {
    label: `/${command.name}`,
    description: /^[ -~]*$/.test(command.description) ? t('guid.commandFallback') : command.description,
    localized: false,
  };
};
