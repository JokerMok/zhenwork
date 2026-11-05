/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar, Button, Dropdown, Menu, Tooltip } from '@arco-design/web-react';
import { ArrowCircleLeft, CloseOne, Down, Moon, SettingTwo, SunOne } from '@icon-park/react';
import classNames from 'classnames';
import { useNavigate } from 'react-router-dom';
import { useAuth, type AuthUser } from '@renderer/hooks/context/AuthContext';
import { enterpriseRequest } from '@renderer/pages/workspace/workspaceApi';
import { iconColors } from '@renderer/styles/colors';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

type SiderFooterProps = {
  isMobile: boolean;
  isSettings: boolean;
  enterpriseWeb?: boolean;
  onSessionClick?: () => void;
  collapsed?: boolean;
  theme: string;
  siderTooltipProps: SiderTooltipProps;
  onSettingsClick: () => void;
  onThemeToggle: () => void;
  showLogout?: boolean;
  onLogoutClick?: () => void;
};

type EmployeeProfile = { id: string; nickname?: string; avatarUrl?: string };

const ACCOUNT_ROUTES = {
  profile: '/settings/profile',
  personalization: '/settings/personalization',
  settings: '/settings',
} as const;

const footerClasses =
  'shrink-0 sider-footer mt-auto py-8px border-t border-solid border-[var(--color-border-2)] border-s-0 border-e-0 border-b-0';

const avatarSource = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin === window.location.origin || url.protocol === 'https:') return url.href;
  } catch {
    // Fall back to the employee's initial for unsupported avatar URLs.
  }
  return undefined;
};

function EmployeeAccountMenu({
  user,
  collapsed,
  onSessionClick,
  onLogoutClick,
}: {
  user: AuthUser;
  collapsed: boolean;
  onSessionClick?: () => void;
  onLogoutClick?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const menuId = useId();
  const [profile, setProfile] = useState<EmployeeProfile>();
  const [visible, setVisible] = useState(false);
  const [failedAvatar, setFailedAvatar] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null);
  const { id, username } = user;

  useEffect(() => {
    let current: AbortController | undefined;
    const refresh = () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      void enterpriseRequest<EmployeeProfile>('/enterprise/self-profile', { signal: controller.signal })
        .then((result) => {
          if (!controller.signal.aborted && String(result?.id) === id) setProfile(result);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('enterprise-profile-updated', refresh);
    return () => {
      current?.abort();
      window.removeEventListener('enterprise-profile-updated', refresh);
    };
  }, [id]);

  const displayName = typeof profile?.nickname === 'string' && profile.nickname.trim() ? profile.nickname.trim() : username;
  const avatar = typeof profile?.avatarUrl === 'string' ? avatarSource(profile.avatarUrl) : undefined;
  const getItems = useCallback(
    () => Array.from(document.getElementById(menuId)?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    [menuId]
  );
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => getItems()[0]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [getItems, visible]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && visible) {
      event.preventDefault();
      event.stopPropagation();
      setVisible(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === 'Tab' && visible) {
      setVisible(false);
      trigger.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!visible) {
      setVisible(true);
      return;
    }
    const items = getItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const menu = (
    <Menu
      id={menuId}
      aria-label={t('login.enterpriseAccountLabel')}
      onClickMenuItem={(key) => {
        if (key === 'logout') {
          onLogoutClick?.();
        } else if (Object.hasOwn(ACCOUNT_ROUTES, key)) {
          void navigate(ACCOUNT_ROUTES[key as keyof typeof ACCOUNT_ROUTES]);
          onSessionClick?.();
        }
      }}
    >
      <Menu.Item key='profile'>{t('settings.enterpriseAccount.profile', { defaultValue: 'Personal profile' })}</Menu.Item>
      <Menu.Item key='personalization'>
        {t('settings.enterpriseAccount.personalization', { defaultValue: 'Personalization' })}
      </Menu.Item>
      <Menu.Item key='settings'>{t('common.settings')}</Menu.Item>
      <Menu.Item key='logout'>{t('settings.googleLogout')}</Menu.Item>
    </Menu>
  );

  return (
    <div className={footerClasses} onKeyDown={onKeyDown}>
      <Dropdown
        droplist={menu}
        trigger='click'
        position='tl'
        popupVisible={visible}
        onVisibleChange={setVisible}
        triggerProps={{ autoAlignPopupWidth: !collapsed }}
      >
        <Button
          ref={trigger}
          type='text'
          long
          className={classNames('!h-40px !rd-8px !text-t-primary', collapsed ? '!p-0' : '!px-8px')}
          data-testid='employee-account-menu'
          aria-label={displayName}
          aria-haspopup='menu'
          aria-expanded={visible}
          aria-controls={visible ? menuId : undefined}
          title={displayName}
        >
          <span className={classNames('w-full min-w-0 flex items-center gap-8px', collapsed && 'justify-center')}>
            <Avatar size={28} className='shrink-0' aria-hidden='true'>
              {avatar && avatar !== failedAvatar ? (
                <img src={avatar} alt='' referrerPolicy='no-referrer' onError={() => setFailedAvatar(avatar)} />
              ) : Array.from(displayName.trim())[0]?.toLocaleUpperCase()}
            </Avatar>
            {!collapsed && (
              <>
                <span className='min-w-0 flex-1 truncate text-start font-medium'>{displayName}</span>
                <Down theme='outline' size={14} className='shrink-0 text-t-secondary' aria-hidden='true' />
              </>
            )}
          </span>
        </Button>
      </Dropdown>
    </div>
  );
}

const SiderFooter: React.FC<SiderFooterProps> = ({
  isMobile,
  isSettings,
  enterpriseWeb = false,
  onSessionClick,
  collapsed = false,
  theme,
  siderTooltipProps,
  onSettingsClick,
  onThemeToggle,
  showLogout = false,
  onLogoutClick,
}) => {
  const { t } = useTranslation();
  const { user, status } = useAuth();

  if (enterpriseWeb) {
    return status === 'authenticated' && user ? (
      <EmployeeAccountMenu
        key={user.id}
        user={user}
        collapsed={collapsed}
        onSessionClick={onSessionClick}
        onLogoutClick={onLogoutClick}
      />
    ) : null;
  }

  const enterprise = (window as Window & { enterpriseContext?: {
    username: string;
    userId: string;
    serverUrl: string;
    modelName: string;
  } }).enterpriseContext;
  const enterpriseHost = (() => {
    try { return enterprise?.serverUrl ? new URL(enterprise.serverUrl).host : ''; }
    catch { return ''; }
  })();

  const settingsIcon = isSettings ? (
    <ArrowCircleLeft
      theme='outline'
      size='16'
      fill='currentColor'
      className='block leading-none'
      style={{ lineHeight: 0 }}
    />
  ) : (
    <SettingTwo
      theme='outline'
      size='16'
      fill='currentColor'
      className='block leading-none'
      style={{ lineHeight: 0 }}
    />
  );
  const showThemeToggle = isSettings && !collapsed;
  const themeTooltip = theme === 'dark' ? t('settings.lightMode') : t('settings.darkMode');

  return (
    <div className={footerClasses}>
      {enterprise && !collapsed && (
        <div className='px-10px pb-8px text-11px text-t-secondary leading-18px' role='status'
          title={`${enterprise.serverUrl} · ${enterprise.userId}`}>
          <div className='font-[600] text-t-primary'>{t('login.enterpriseConnected')}</div>
          <div className='truncate'>{t('login.enterpriseAccountLabel')}：{enterprise.username || enterprise.userId}</div>
          <div className='truncate'>{t('login.enterpriseServerLabel')}：{enterpriseHost}</div>
          <div className='truncate'>{t('login.enterpriseModelLabel')}：{enterprise.modelName}</div>
        </div>
      )}
      <div className={classNames('flex', collapsed ? 'flex-col gap-2px' : 'items-center gap-2px')}>
        <Tooltip {...siderTooltipProps} content={isSettings ? t('common.back') : t('common.settings')} position='right'>
          <div
            onClick={onSettingsClick}
            className={classNames(
              'group h-34px flex items-center rd-0.5rem cursor-pointer transition-colors',
              collapsed ? 'w-full justify-center' : 'flex-1 min-w-0 justify-start gap-8px ps-10px pe-8px',
              isMobile && 'sider-footer-btn-mobile',
              {
                'bg-fill-3': isSettings,
                'hover:bg-fill-3 active:bg-fill-4': !isSettings,
              }
            )}
          >
            <span className='size-22px flex items-center justify-center shrink-0 text-t-secondary'>{settingsIcon}</span>
            <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px truncate'>
              {isSettings ? t('common.back') : t('common.settings')}
            </span>
          </div>
        </Tooltip>
        {showLogout && onLogoutClick && (
          <Tooltip {...siderTooltipProps} content={t('settings.googleLogout')} position='right'>
            <div
              onClick={onLogoutClick}
              className={classNames(
                'h-32px flex items-center rd-0.5rem cursor-pointer transition-colors hover:bg-[rgba(var(--primary-6),0.14)] active:bg-fill-2',
                collapsed ? 'w-full justify-center' : 'flex-1 min-w-0 justify-start gap-10px px-14px',
                isMobile && 'sider-footer-btn-mobile'
              )}
            >
              <span className='size-20px flex items-center justify-center shrink-0'>
                <CloseOne
                  theme='outline'
                  size='16'
                  fill={iconColors.primary}
                  className='block leading-none'
                  style={{ lineHeight: 0 }}
                />
              </span>
              <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px truncate'>
                {t('settings.googleLogout')}
              </span>
            </div>
          </Tooltip>
        )}
        {/* Theme toggle — lightweight icon button, only while inside Settings page (not in collapsed mode) */}
        {showThemeToggle && (
          <Tooltip {...siderTooltipProps} content={themeTooltip} position='right'>
            <div
              onClick={onThemeToggle}
              data-testid='theme-toggle'
              className={classNames(
                'h-32px w-40px shrink-0 flex items-center justify-center cursor-pointer rd-0.5rem transition-colors text-t-secondary hover:bg-fill-2 hover:text-t-primary active:bg-fill-3',
                isMobile && 'sider-footer-btn-mobile'
              )}
              aria-label={themeTooltip}
            >
              <span className='w-28px h-28px flex items-center justify-center shrink-0'>
                {theme === 'dark' ? (
                  <SunOne theme='outline' size='18' fill='currentColor' className='block leading-none' />
                ) : (
                  <Moon theme='outline' size='18' fill='currentColor' className='block leading-none' />
                )}
              </span>
            </div>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

export default SiderFooter;
