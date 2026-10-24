import { Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { isEnterpriseWeb } from '@/renderer/utils/platform';

const AppLoader: React.FC = () => {
  const { t } = useTranslation();
  const brand = isEnterpriseWeb() ? document.title.trim() || 'ZhenWork' : null;
  return (
    <div role='status' aria-label={t('common.loading')} style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      {brand && <span className='text-t-primary text-20px font-600'>{brand}</span>}
      <Spin dot />
    </div>
  );
};

export default AppLoader;
