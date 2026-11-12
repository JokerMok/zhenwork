import { requestEnterpriseBrand } from '@/renderer/components/layout/enterpriseBrand';
import { Button, Card, Grid } from '@arco-design/web-react';
import { ChartHistogram, DataFile, Expenses, FileEditing, Right } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

const WorkspaceHome: React.FC = () => {
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
    <div className='min-w-0 flex flex-col gap-22px'>
      <div>
        <h1 className='m-0 text-28px font-semibold text-t-primary'>
          {t('workspace.home.welcome', { brand: brandName })}
        </h1>
      </div>
      <section>
        <div className='mb-10px flex flex-wrap items-center justify-between gap-12px'>
          <h2 className='m-0 text-17px font-semibold text-t-primary'>{t('workspace.home.startTitle')}</h2>
          <Button type='primary' onClick={() => navigate('/guid')}>
            {t('workspace.home.blankTask')} <Right theme='outline' />
          </Button>
        </div>
        <Grid.Row gutter={[12, 12]}>
          {examples.map((example) => (
            <Grid.Col key={example.key} xs={24} md={12}>
              <Card className='h-full' bodyStyle={{ padding: 0 }}>
                <Button
                  type='text'
                  className='w-full min-w-0'
                  style={{ height: 'auto', padding: 16, textAlign: 'start', whiteSpace: 'normal' }}
                  onClick={() => navigate('/guid', { state: { prefillPrompt: example.prompt, focusPrefill: true } })}
                >
                  <span className='flex items-start gap-12px'>
                    <span
                      aria-hidden='true'
                      className='mt-2px size-34px shrink-0 flex items-center justify-center rd-8px bg-fill-2 text-t-primary'
                    >
                      {example.icon}
                    </span>
                    <span className='block min-w-0 break-words'>
                      <span className='block font-medium text-t-primary'>{example.title}</span>
                      <span className='mt-5px block text-13px leading-20px text-t-secondary'>{example.prompt}</span>
                    </span>
                  </span>
                </Button>
              </Card>
            </Grid.Col>
          ))}
        </Grid.Row>
      </section>
    </div>
  );
};

export default WorkspaceHome;
