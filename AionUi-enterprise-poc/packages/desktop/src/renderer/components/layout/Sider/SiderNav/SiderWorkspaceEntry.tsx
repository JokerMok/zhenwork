import { Tooltip } from '@arco-design/web-react';
import { Workbench } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

type SiderWorkspaceEntryProps = {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
};

const SiderWorkspaceEntry: React.FC<SiderWorkspaceEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const label = t('workspace.title');

  return (
    <Tooltip {...siderTooltipProps} content={label} position='right'>
      <div
        className={classNames(
          'box-border group h-34px w-full flex items-center cursor-pointer transition-colors rd-8px text-t-primary',
          collapsed ? 'justify-center' : 'justify-start gap-8px ps-10px pe-8px',
          isMobile && 'sider-action-btn-mobile',
          isActive ? 'bg-fill-3' : 'hover:bg-fill-3 active:bg-fill-4'
        )}
        onClick={onClick}
      >
        <span className='size-22px flex items-center justify-center shrink-0'>
          <Workbench theme='outline' size={collapsed ? 20 : 16} fill='currentColor' />
        </span>
        {!collapsed ? <span className='text-14px font-[500] leading-24px'>{label}</span> : null}
      </div>
    </Tooltip>
  );
};

export default SiderWorkspaceEntry;
