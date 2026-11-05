import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppLoader from '@renderer/components/layout/AppLoader';
import DocumentTitle from '@renderer/components/layout/DocumentTitle';
import { useCrossSessionRateLimitNotice } from '@/renderer/hooks/system/useCrossSessionRateLimitNotice';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { TEAM_MODE_ENABLED } from '@/common/config/constants';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { workspaceCapabilityPath } from '@renderer/pages/workspace/workspaceCatalog';
const Conversation = React.lazy(() => import('@renderer/pages/conversation'));
const Guid = React.lazy(() => import('@renderer/pages/guid'));
const AgentSettings = React.lazy(() => import('@renderer/pages/settings/AgentSettings'));
const AgentRepairPage = React.lazy(() => import('@renderer/pages/settings/AgentSettings/AgentRepairPage'));
const AssistantSettings = React.lazy(() => import('@renderer/pages/settings/AssistantSettings'));
const SkillsSettings = React.lazy(() => import('@renderer/pages/settings/SkillsSettings/SkillsHubSettings'));
const SkillDetailPage = React.lazy(() => import('@renderer/pages/settings/SkillsSettings/SkillDetailPage'));
const ToolsSettings = React.lazy(() => import('@renderer/pages/settings/ToolsSettings'));
const AppearanceSettings = React.lazy(() => import('@renderer/pages/settings/AppearanceSettings'));
const ModeSettings = React.lazy(() => import('@renderer/pages/settings/ModeSettings'));
const SystemSettings = React.lazy(() => import('@renderer/pages/settings/SystemSettings'));
const WebuiSettings = React.lazy(() => import('@renderer/pages/settings/WebuiSettings'));
const ArchivedSettings = React.lazy(() => import('@renderer/pages/settings/ArchivedSettings'));
const ExtensionSettingsPage = React.lazy(() => import('@renderer/pages/settings/ExtensionSettingsPage'));
const EnterprisePersonalSettings = React.lazy(() => import('@renderer/pages/EnterprisePersonalSettings'));
const LoginPage = React.lazy(() => import('@renderer/pages/login'));
const ComponentsShowcase = React.lazy(() => import('@renderer/pages/TestShowcase'));
const ScheduledTasksPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage'));
const TaskDetailPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage/TaskDetailPage'));
const TeamIndex = React.lazy(() => import('@renderer/pages/team'));
const Workspace = React.lazy(() => import('@renderer/pages/workspace'));

const enterpriseHome = (): string => (isEnterpriseWeb() ? '/workspace' : '/guid');

const withRouteFallback = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <Suspense fallback={<AppLoader contained />}>
    <Component />
  </Suspense>
);

const accountSettings = (section: 'profile' | 'personalization') => (
  <Suspense fallback={<AppLoader contained />}>
    <EnterprisePersonalSettings section={section} />
  </Suspense>
);

/** Keep legacy Capabilities bookmarks on the corresponding catalog tab. */
const CapabilitiesRedirect: React.FC = () => {
  const { pathname, search } = useLocation();
  const tools =
    new URLSearchParams(search).get('tab') === 'tools' || pathname.startsWith('/settings/capabilities/tools');
  const target = isEnterpriseWeb()
    ? workspaceCapabilityPath(tools ? 'MCP' : 'SKILL')
    : tools
      ? '/settings/tools'
      : '/settings/skills';
  return <Navigate to={target} replace />;
};

const ProtectedLayout: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status, user } = useAuth();
  const location = useLocation();
  // Mounted once for every authenticated route: the loop warning has to reach
  // the user even when they are looking at a THIRD conversation, which is the
  // whole reason it is a broadcast rather than an in-conversation banner.
  useCrossSessionRateLimitNotice(user?.id);

  if (status === 'checking') {
    return <AppLoader />;
  }

  if (status !== 'authenticated') {
    return <Navigate to='/login' state={{ from: location.pathname + location.search }} replace />;
  }

  return React.cloneElement(layout);
};

const PanelRoute: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status } = useAuth();
  const hostedWeb = isEnterpriseWeb();

  return (
    <HashRouter>
      <DocumentTitle />
      <Routes>
        <Route path='/login' element={withRouteFallback(LoginPage)} />
        <Route element={<ProtectedLayout layout={layout} />}>
          <Route index element={<Navigate to={enterpriseHome()} replace />} />
          <Route path='/workspace' element={withRouteFallback(Workspace)} />
          <Route path='/guid' element={withRouteFallback(Guid)} />
          <Route path='/conversation/:id' element={withRouteFallback(Conversation)} />
          <Route
            path='/team/:id'
            element={TEAM_MODE_ENABLED ? withRouteFallback(TeamIndex) : <Navigate to='/guid' replace />}
          />
          {hostedWeb ? (
            <>
              <Route path='/assistants/*' element={<Navigate to={workspaceCapabilityPath('ASSISTANT')} replace />} />
              <Route
                path='/settings/assistants/*'
                element={<Navigate to={workspaceCapabilityPath('ASSISTANT')} replace />}
              />
              <Route
                path='/settings/agent/*'
                element={<Navigate to={workspaceCapabilityPath('ASSISTANT')} replace />}
              />
              <Route path='/settings/model/*' element={<Navigate to={workspaceCapabilityPath('MODEL')} replace />} />
              <Route path='/settings/skills/*' element={<Navigate to={workspaceCapabilityPath('SKILL')} replace />} />
              <Route
                path='/settings/skills-hub/*'
                element={<Navigate to={workspaceCapabilityPath('SKILL')} replace />}
              />
              <Route
                path='/settings/tools/image-generation/*'
                element={<Navigate to={workspaceCapabilityPath('TOOL')} replace />}
              />
              <Route path='/settings/tools/*' element={<Navigate to={workspaceCapabilityPath('MCP')} replace />} />
              <Route path='/settings/capabilities/*' element={<CapabilitiesRedirect />} />
              <Route path='/settings/profile' element={accountSettings('profile')} />
              <Route path='/settings/personalization' element={accountSettings('personalization')} />
              <Route path='/settings/system/*' element={<Navigate to='/settings/appearance' replace />} />
              <Route path='/settings/*' element={<Navigate to='/settings/profile' replace />} />
            </>
          ) : (
            <>
              <Route path='/settings/model' element={withRouteFallback(ModeSettings)} />
              <Route path='/assistants' element={withRouteFallback(AssistantSettings)} />
              <Route path='/settings/assistants' element={<Navigate to='/assistants' replace />} />
              <Route path='/settings/agent' element={withRouteFallback(AgentSettings)} />
              <Route path='/settings/agent/:id/repair' element={withRouteFallback(AgentRepairPage)} />
              <Route path='/settings/skills' element={withRouteFallback(SkillsSettings)} />
              <Route path='/settings/skills/import-history' element={withRouteFallback(SkillsSettings)} />
              <Route path='/settings/skills/detail/:skillName' element={withRouteFallback(SkillDetailPage)} />
              <Route path='/settings/tools' element={withRouteFallback(ToolsSettings)} />
              <Route path='/settings/capabilities' element={<CapabilitiesRedirect />} />
              <Route
                path='/settings/capabilities/skills/import-history'
                element={<Navigate to='/settings/skills/import-history' replace />}
              />
              <Route path='/settings/skills-hub' element={<Navigate to='/settings/skills' replace />} />
              <Route path='/settings/webui' element={withRouteFallback(WebuiSettings)} />
              <Route path='/settings/pet' element={<Navigate to='/settings/system' replace />} />
              <Route path='/settings/system' element={withRouteFallback(SystemSettings)} />
              <Route path='/settings/ext/:tabId' element={withRouteFallback(ExtensionSettingsPage)} />
              <Route path='/settings' element={<Navigate to='/settings/agent' replace />} />
              <Route path='/test/components' element={withRouteFallback(ComponentsShowcase)} />
            </>
          )}
          <Route path='/settings/appearance' element={withRouteFallback(AppearanceSettings)} />
          <Route path='/settings/display' element={<Navigate to='/settings/appearance' replace />} />
          <Route path='/settings/archived' element={withRouteFallback(ArchivedSettings)} />
          <Route path='/settings/about' element={withRouteFallback(SystemSettings)} />
          <Route path='/scheduled' element={withRouteFallback(ScheduledTasksPage)} />
          <Route path='/scheduled/:job_id' element={withRouteFallback(TaskDetailPage)} />
        </Route>
        <Route path='*' element={<Navigate to={status === 'authenticated' ? enterpriseHome() : '/login'} replace />} />
      </Routes>
    </HashRouter>
  );
};

export default PanelRoute;
