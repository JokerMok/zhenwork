import { requestEnterpriseBrand } from '@/renderer/components/layout/enterpriseBrand';
import { Button, Card, Grid } from '@arco-design/web-react';
import { ChartHistogram, DataFile, Expenses, FileEditing, Right } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

type WorkspaceHomeProps = { onOpenSection: (section: string) => void };

const WorkspaceHome: React.FC<WorkspaceHomeProps> = ({ onOpenSection }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [brandName, setBrandName] = useState('ZhenWork');

  useEffect(() => {
    let cancelled = false;
    void requestEnterpriseBrand()
      .then((brand) => {
        if (!cancelled && brand?.productName) setBrandName(brand.productName);
      })
      .catch((): undefined => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const examples = useMemo(
    () => [
      {
        key: 'reimbursement',
        icon: <Expenses theme='outline' />,
        title: t('workspace.examples.reimbursement.title'),
        prompt: t('workspace.examples.reimbursement.prompt'),
      },
      {
        key: 'requirements',
        icon: <FileEditing theme='outline' />,
        title: t('workspace.examples.requirements.title'),
        prompt: t('workspace.examples.requirements.prompt'),
      },
      {
        key: 'data',
        icon: <DataFile theme='outline' />,
        title: t('workspace.examples.data.title'),
        prompt: t('workspace.examples.data.prompt'),
      },
      {
        key: 'market',
        icon: <ChartHistogram theme='outline' />,
        title: t('workspace.examples.market.title'),
        prompt: t('workspace.examples.market.prompt'),
      },
    ],
    [t]
  );

  return (
    <div className='flex flex-col gap-22px'>
      <div>
        <div className='text-28px font-semibold text-t-primary'>{t('workspace.home.welcome', { brand: brandName })}</div>
        <div className='mt-6px text-14px text-t-secondary'>{t('workspace.home.subtitle')}</div>
      </div>
      <section>
        <div className='mb-10px flex items-center justify-between gap-12px'>
          <div>
            <div className='text-17px font-semibold text-t-primary'>{t('workspace.home.startTitle')}</div>
            <div className='mt-2px text-13px text-t-secondary'>{t('workspace.home.startHint')}</div>
          </div>
          <Button type='text' onClick={() => navigate('/guid')}>
            {t('workspace.home.blankTask')} <Right theme='outline' />
          </Button>
        </div>
        <Grid.Row gutter={[12, 12]}>
          {examples.map((example) => (
            <Grid.Col key={example.key} xs={24} md={12}>
              <Card
                hoverable
                className='h-full cursor-pointer'
                onClick={() => navigate('/guid', { state: { prefillPrompt: example.prompt, focusPrefill: true } })}
              >
                <div className='flex items-start gap-12px'>
                  <span className='mt-2px size-34px shrink-0 flex items-center justify-center rd-8px bg-fill-2 text-t-primary'>
                    {example.icon}
                  </span>
                  <div className='min-w-0'>
                    <div className='font-medium text-t-primary'>{example.title}</div>
                    <div className='mt-5px text-13px leading-20px text-t-secondary'>{example.prompt}</div>
                  </div>
                </div>
              </Card>
            </Grid.Col>
          ))}
        </Grid.Row>
      </section>
      <Card title={t('workspace.home.manageTitle')}>
        <div className='flex flex-wrap gap-8px'>
          <Button onClick={() => onOpenSection('tasks')}>{t('workspace.tabs.tasks')}</Button>
          <Button onClick={() => onOpenSection('files')}>{t('workspace.tabs.files')}</Button>
          <Button onClick={() => onOpenSection('knowledge')}>{t('workspace.tabs.knowledge')}</Button>
          <Button onClick={() => onOpenSection('abilities')}>{t('workspace.tabs.abilities')}</Button>
          <Button onClick={() => onOpenSection('memory')}>{t('workspace.tabs.memory')}</Button>
        </div>
      </Card>
    </div>
  );
};

export default WorkspaceHome;
