import { Button, Tabs, Spin } from '@arco-design/web-react';
import { AlarmClock, Book, FileCabinet, Home, ListCheckbox, Memory, Robot } from '@icon-park/react';
import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useNavigationType, useSearchParams } from 'react-router-dom';
import { workspaceCapabilityType, type CapabilityType } from './workspaceCatalog';
const WorkspaceCapabilities = React.lazy(() => import('./WorkspaceCapabilities'));
const WorkspaceFiles = React.lazy(() => import('./WorkspaceFiles'));
import WorkspaceHome from './WorkspaceHome';
const WorkspaceKnowledge = React.lazy(() => import('./WorkspaceKnowledge'));
const WorkspaceMemory = React.lazy(() => import('./WorkspaceMemory'));
const WorkspaceTasks = React.lazy(() => import('./WorkspaceTasks'));

const deferred = (content: React.ReactNode) => (
  <Suspense fallback={<Spin className='w-full py-24px' />}>{content}</Suspense>
);

const SECTIONS = new Set(['home', 'tasks', 'files', 'knowledge', 'abilities', 'memory']);

type WorkspaceView = { section: string; task: string | null };
type ScrollProps = React.PropsWithChildren<WorkspaceView & { historyNavigation: boolean }>;

const viewKey = ({ section, task }: WorkspaceView) => JSON.stringify([section, task]);

class WorkspaceScroll extends React.Component<ScrollProps> {
  private readonly scroller = React.createRef<HTMLDivElement>();
  private readonly content = React.createRef<HTMLDivElement>();
  private readonly positions = new Map<string, number>();
  private observer?: ResizeObserver;
  private lastTask: string | null = null;

  componentDidMount() {
    this.restore();
  }

  getSnapshotBeforeUpdate(previous: ScrollProps): WorkspaceView | null {
    const key = viewKey(previous);
    if (key === viewKey(this.props)) return null;
    // Read before the DOM changes: a shorter pane clamps scrollTop during layout.
    if (!this.observer && this.scroller.current) this.positions.set(key, this.scroller.current.scrollTop);
    this.cancelRestore();
    return previous;
  }

  componentDidUpdate(_previous: ScrollProps, _state: unknown, outgoing: WorkspaceView | null) {
    if (outgoing) this.restore(outgoing);
  }

  componentWillUnmount() {
    this.cancelRestore();
  }

  private cancelRestore = () => {
    this.observer?.disconnect();
    this.observer = undefined;
  };

  private restore(outgoing?: WorkspaceView) {
    const scroll = this.scroller.current;
    const content = this.content.current;
    if (!scroll || !content) return;
    const { section, task, historyNavigation } = this.props;
    const saved = this.positions.get(viewKey(this.props));
    const revealTask = Boolean(task && (saved === undefined || (!historyNavigation && task !== this.lastTask)));
    const focusTask = revealTask || Boolean(task && outgoing?.section === 'tasks' && outgoing.task !== task);
    if (section === 'tasks') this.lastTask = task;

    const apply = () => {
      const heading = focusTask ? content.querySelector<HTMLHeadingElement>('#workspace-task-detail-title') : null;
      if (focusTask && !heading) return false;
      const target = saved ?? 0;
      if (!revealTask) scroll.scrollTop = target;
      if (heading) {
        const viewport = scroll.getBoundingClientRect();
        const tabBottom = content.querySelector('[role="tablist"]')?.getBoundingClientRect().bottom ?? viewport.top;
        const visibleTop = Math.max(viewport.top, tabBottom);
        const detailBottom = heading.closest('section')?.getBoundingClientRect().bottom;
        const headingRect = heading.getBoundingClientRect();
        // A position below the detail is in the list (for example after
        // scrolling to open another task). Return to the heading in that case.
        if (revealTask || (detailBottom !== undefined && detailBottom <= visibleTop)) {
          scroll.scrollTop = Math.max(0, scroll.scrollTop + headingRect.top - visibleTop - 16);
          heading.focus({ preventScroll: true });
          return true;
        }
        if (headingRect.top >= visibleTop && headingRect.bottom <= viewport.bottom) {
          heading.focus({ preventScroll: true });
        }
      }
      return scroll.scrollTop >= target - 1;
    };

    if (!apply() && typeof ResizeObserver !== 'undefined') {
      // A lazy pane or task detail can be shorter until its content arrives.
      this.observer = new ResizeObserver(() => {
        if (apply()) this.cancelRestore();
      });
      this.observer.observe(content);
    }
  }

  render() {
    return (
      <div
        ref={this.scroller}
        className='h-full min-h-0 min-w-0 overflow-y-auto bg-bg-1'
        style={{ overflowAnchor: 'none' }}
        onWheelCapture={this.cancelRestore}
        onTouchStartCapture={this.cancelRestore}
        onPointerDownCapture={this.cancelRestore}
        onKeyDownCapture={this.cancelRestore}
      >
        <div
          ref={this.content}
          className='box-border mx-auto w-full min-w-0 max-w-1180px px-18px py-18px md:px-28px md:py-24px'
        >
          {this.props.children}
        </div>
      </div>
    );
  }
}

const WorkspacePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const historyNavigation = useNavigationType() === 'POP';
  const requested = params.get('section') || 'home';
  const active = SECTIONS.has(requested) ? requested : 'home';
  const capability = workspaceCapabilityType(params.get('capability'));
  const setCapability = (type: CapabilityType) => {
    setParams({ section: 'abilities', capability: type }, { replace: true });
  };
  const setActive = (section: string) => {
    const next = new URLSearchParams(params);
    if (section !== active) {
      next.delete('previewPath');
      next.delete('fileVersion');
    }
    if (section === 'home') next.delete('section');
    else next.set('section', section);
    setParams(next, { replace: true });
  };

  return (
    <WorkspaceScroll
      section={active}
      task={active === 'tasks' ? params.get('task') : null}
      historyNavigation={historyNavigation}
    >
      <Tabs
        activeTab={active}
        onChange={setActive}
        type='rounded'
        className='!overflow-visible [&>.arco-tabs-header-nav]:sticky [&>.arco-tabs-header-nav]:top-0 [&>.arco-tabs-header-nav]:z-10 [&>.arco-tabs-header-nav]:bg-bg-1'
      >
        <Tabs.TabPane
          key='home'
          title={
            <span className='flex items-center gap-6px'>
              <Home />
              {t('workspace.tabs.home')}
            </span>
          }
        >
          <WorkspaceHome />
        </Tabs.TabPane>
        <Tabs.TabPane
          key='tasks'
          title={
            <span className='flex items-center gap-6px'>
              <ListCheckbox />
              {t('workspace.tabs.tasks')}
            </span>
          }
        >
          {deferred(<WorkspaceTasks />)}
        </Tabs.TabPane>
        <Tabs.TabPane
          key='files'
          title={
            <span className='flex items-center gap-6px'>
              <FileCabinet />
              {t('workspace.tabs.files')}
            </span>
          }
        >
          {deferred(<WorkspaceFiles active={active === 'files'} />)}
        </Tabs.TabPane>
        <Tabs.TabPane
          key='knowledge'
          title={
            <span className='flex items-center gap-6px'>
              <Book />
              {t('workspace.tabs.knowledge')}
            </span>
          }
        >
          {deferred(<WorkspaceKnowledge />)}
        </Tabs.TabPane>
        <Tabs.TabPane
          key='abilities'
          title={
            <span className='flex items-center gap-6px'>
              <Robot />
              {t('workspace.tabs.abilities')}
            </span>
          }
        >
          {deferred(
            <WorkspaceCapabilities key={capability} capabilityType={capability} onCapabilityChange={setCapability} />
          )}
        </Tabs.TabPane>
        <Tabs.TabPane
          key='memory'
          title={
            <span className='flex items-center gap-6px'>
              <Memory />
              {t('workspace.tabs.memory')}
            </span>
          }
        >
          {deferred(<WorkspaceMemory />)}
        </Tabs.TabPane>
      </Tabs>
      {active === 'tasks' && params.has('previewPath') && deferred(<WorkspaceFiles previewOnly />)}
      <Button type='text' className='mt-16px' icon={<AlarmClock />} onClick={() => navigate('/scheduled')}>
        {t('workspace.openScheduled')}
      </Button>
    </WorkspaceScroll>
  );
};

export default WorkspacePage;
