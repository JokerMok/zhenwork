import { Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { isEnterpriseWeb } from '@/renderer/utils/platform';

const AppLoader: React.FC<{ contained?: boolean }> = ({ contained = false }) => {
  const { t } = useTranslation();
  if (!isEnterpriseWeb())
    return (
      <div role='status' aria-label={t('common.loading')} className='min-h-100vh flex items-center justify-center'>
        <Spin dot />
      </div>
    );
  return (
    <div
      role='status'
      aria-label={t('common.loading')}
      className={`${contained ? 'h-full' : 'h-100dvh'} min-h-0 flex bg-bg-1`}
      data-testid='workbench-skeleton'
    >
      {!contained && (
        <aside className='w-224px shrink-0 bg-bg-2 p-20px hidden md:block'>
          <div className='h-24px w-120px bg-bg-3 rd-6px mb-28px' />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='h-14px w-80% bg-bg-3 rd-6px mb-22px' />
          ))}
        </aside>
      )}
      <div className='min-w-0 flex-1 flex flex-col'>
        <div className='h-52px border-b border-solid border-border-2' />
        <div className='flex-1' />
        <div className='mx-auto w-80% max-w-880px pb-28px'>
          <div className='h-64px rd-12px bg-bg-2' />
        </div>
      </div>
    </div>
  );
};
export default AppLoader;
