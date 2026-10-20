import { Button, Tabs } from '@arco-design/web-react';
import { AlarmClock, Book, FileCabinet, Home, ListCheckbox, Memory, Robot } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import WorkspaceCapabilities from './WorkspaceCapabilities';
import WorkspaceFiles from './WorkspaceFiles';
import WorkspaceHome from './WorkspaceHome';
import WorkspaceKnowledge from './WorkspaceKnowledge';
import WorkspaceMemory from './WorkspaceMemory';
import WorkspaceTasks from './WorkspaceTasks';

const SECTIONS = new Set(['home', 'tasks', 'files', 'knowledge', 'abilities', 'memory']);

const WorkspacePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get('section') || 'home';
  const active = SECTIONS.has(requested) ? requested : 'home';
  const setActive = (section: string) => {
    const next = new URLSearchParams(params);
    if (section === 'home') next.delete('section');
    else next.set('section', section);
    setParams(next, { replace: true });
  };

  return (
    <div className='h-full min-h-0 overflow-y-auto bg-bg-1'>
      <div className='mx-auto w-full max-w-1180px px-18px py-18px md:px-28px md:py-24px'>
        <Tabs activeTab={active} onChange={setActive} type='rounded'>
          <Tabs.TabPane key='home' title={<span className='flex items-center gap-6px'><Home />{t('workspace.tabs.home')}</span>}><WorkspaceHome onOpenSection={setActive} /></Tabs.TabPane>
          <Tabs.TabPane key='tasks' title={<span className='flex items-center gap-6px'><ListCheckbox />{t('workspace.tabs.tasks')}</span>}><WorkspaceTasks /></Tabs.TabPane>
          <Tabs.TabPane key='files' title={<span className='flex items-center gap-6px'><FileCabinet />{t('workspace.tabs.files')}</span>}><WorkspaceFiles /></Tabs.TabPane>
          <Tabs.TabPane key='knowledge' title={<span className='flex items-center gap-6px'><Book />{t('workspace.tabs.knowledge')}</span>}><WorkspaceKnowledge /></Tabs.TabPane>
          <Tabs.TabPane key='abilities' title={<span className='flex items-center gap-6px'><Robot />{t('workspace.tabs.abilities')}</span>}><WorkspaceCapabilities /></Tabs.TabPane>
          <Tabs.TabPane key='memory' title={<span className='flex items-center gap-6px'><Memory />{t('workspace.tabs.memory')}</span>}><WorkspaceMemory /></Tabs.TabPane>
        </Tabs>
        <Button type='text' className='mt-16px' icon={<AlarmClock />} onClick={() => navigate('/scheduled')}>{t('workspace.openScheduled')}</Button>
      </div>
    </div>
  );
};

export default WorkspacePage;
