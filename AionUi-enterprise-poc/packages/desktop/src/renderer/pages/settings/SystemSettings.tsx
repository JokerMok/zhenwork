/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import SystemModalContent from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent';
import AboutModalContent from '@/renderer/components/settings/SettingsModal/contents/AboutModalContent';
import SettingsPageWrapper from './components/SettingsPageWrapper';

const SystemSettings: React.FC = () => {
  const location = useLocation();
  const { t } = useTranslation();
  const isAboutPage = location.pathname === '/settings/about';

  if (isEnterpriseWeb()) {
    const version = (window as Window & { __AION_ENTERPRISE_VERSION__?: string }).__AION_ENTERPRISE_VERSION__;
    return (
      <SettingsPageWrapper contentClassName='max-w-640px'>
        <h1 className='m-0 text-20px font-semibold text-t-primary'>{t('settings.about')}</h1>
        <dl className='mt-16px grid grid-cols-[auto_1fr] items-center gap-12px rd-16px bg-2 p-16px'>
          <dt>{document.title}</dt>
          {version && (
            <dd className='m-0 text-t-secondary'>
              {t('common.version')} {version}
            </dd>
          )}
        </dl>
      </SettingsPageWrapper>
    );
  }

  return (
    <SettingsPageWrapper contentClassName={isAboutPage ? 'max-w-640px' : undefined}>
      {isAboutPage ? <AboutModalContent /> : <SystemModalContent />}
    </SettingsPageWrapper>
  );
};

export default SystemSettings;
