import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import WorkspacePage from '@/renderer/pages/workspace/WorkspacePage';
import WorkspaceHome from '@/renderer/pages/workspace/WorkspaceHome';
import WorkspaceTasks from '@/renderer/pages/workspace/WorkspaceTasks';
import { enterpriseRequest } from '@/renderer/pages/workspace/workspaceApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      new Map([
        ['workspace.work.progress.read_document', 'Reading document'],
        ['workspace.work.progress.TOOL_FAILED', 'Tool failed'],
      ]).get(key) ??
      (key.startsWith('workspace.work.progress.') ? options?.defaultValue : key) ??
      key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/renderer/components/layout/enterpriseBrand', () => ({
  requestEnterpriseBrand: async () => ({ productName: 'ZhenWork' }),
}));
vi.mock('@/renderer/pages/workspace/WorkspaceFiles', () => ({
  default: () => <div>File list</div>,
}));
vi.mock('@/renderer/pages/workspace/TaskWork', () => ({
  default: ({ conversationId }: { conversationId: string }) => <output>{conversationId}</output>,
}));
vi.mock('@/renderer/pages/workspace/workspaceApi', () => ({
  enterpriseRequest: vi.fn(),
  workspaceErrorCode: () => 'UNAVAILABLE',
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(enterpriseRequest).mockReset();
});

function Location() {
  const location = useLocation();
  return <output data-testid='location'>{location.pathname + location.search}</output>;
}

function Draft() {
  const location = useLocation();
  return <output>{location.state?.prefillPrompt}</output>;
}

test('home examples are named buttons and open the new task with a draft', async () => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  render(
    <MemoryRouter>
      <Routes>
        <Route path='/' element={<WorkspaceHome />} />
        <Route path='/guid' element={<Draft />} />
      </Routes>
    </MemoryRouter>
  );
  fireEvent.click(screen.getByRole('button', { name: /workspace\.examples\.reimbursement\.title/ }));
  expect(await screen.findByText('workspace.examples.reimbursement.prompt')).toBeTruthy();
});

test('task details are linked by URL while ordinary conversations are not shown as unknown tasks', async () => {
  vi.mocked(enterpriseRequest)
    .mockResolvedValueOnce({ items: [{ id: 'chat-b', name: 'Ordinary chat' }] })
    .mockResolvedValueOnce({
      items: [{ id: 'task-a', title: 'Executed task', updatedAt: 1, attempts: [{ state: 'waiting_input' }] }],
    });
  render(
    <MemoryRouter initialEntries={['/workspace?section=tasks']}>
      <WorkspaceTasks />
      <Location />
    </MemoryRouter>
  );
  expect(await screen.findByText('conversation.history.conversationsSection')).toBeTruthy();
  expect(screen.getByText('workspace.work.states.waiting_input')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'workspace.work.details' }));
  expect(screen.getByTestId('location').textContent).toBe('/workspace?section=tasks&task=task-a');
  expect(screen.getByText('task-a')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/workspace?section=tasks'));
});

const taskListUrl = '/workspace?section=tasks';
const taskUrl = (id: string) => taskListUrl + '&task=' + id;
function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
      <button onClick={() => navigate('/workspace?section=files')}>Files</button>
      <button onClick={() => navigate(taskUrl('task-b'))}>Open B</button>
    </>
  );
}

function mockWork(attempt: { state: string; progress?: string; question?: string; steps?: Array<{ tool: string }> }) {
  vi.mocked(enterpriseRequest).mockImplementation(async (url) => ({
    items:
      url === '/enterprise/tasks'
        ? [
            { id: 'task-a', title: 'Business task A', updatedAt: 1, attempts: [attempt] },
            { id: 'task-b', title: 'Business task B', updatedAt: 2, attempts: [] },
          ]
        : [],
  }));
}

async function openWorkspace() {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media,
    matches: false,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  mockWork({ state: 'completed' });
  const { container } = render(
    <MemoryRouter initialEntries={[taskListUrl]}>
      <WorkspacePage />
      <Navigation />
    </MemoryRouter>
  );
  await screen.findByText('Business task A');
  return container.querySelector<HTMLDivElement>('[data-testid=workspace-scroll]')!;
}

async function tab(section: 'tasks' | 'files') {
  fireEvent.click(screen.getByRole('tab', { name: 'workspace.tabs.' + section }));
  if (section === 'files') await screen.findByText('File list');
}

async function openFirstTask() {
  const trigger = screen.getAllByRole('button', { name: 'workspace.work.details' })[0];
  fireEvent.click(trigger);
  await screen.findByRole('heading', { name: 'Business task A' });
  return trigger;
}

test('returning between Tasks and Files restores each view reading position', async () => {
  const scroller = await openWorkspace();
  scroller.scrollTop = 370;
  await tab('files');
  scroller.scrollTop = 140;
  await tab('tasks');
  expect(scroller.scrollTop).toBe(370);
  await tab('files');
  expect(scroller.scrollTop).toBe(140);
});

test('opening another task from Files positions its heading instead of restoring the previous task scroll', async () => {
  const scroller = await openWorkspace();
  await openFirstTask();
  scroller.scrollTop = 460;
  await tab('files');
  scroller.scrollTop = 190;
  fireEvent.click(screen.getByRole('button', { name: 'Open B' }));
  const heading = await screen.findByRole('heading', { name: 'Business task B' });
  expect(document.activeElement).toBe(heading);
  expect(scroller.scrollTop).toBe(174);
});

test('closing a task after a tab round trip restores the list position and its opening button focus', async () => {
  const scroller = await openWorkspace();
  scroller.scrollTop = 375;
  const trigger = await openFirstTask();
  scroller.scrollTop = 640;
  await tab('files');
  scroller.scrollTop = 120;
  await tab('tasks');
  expect(scroller.scrollTop).toBe(640);
  fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
  expect(scroller.scrollTop).toBe(375);
  expect(document.activeElement).toBe(trigger);
});

test('a polling update preserves restored task scroll and the currently focused control', async () => {
  const schedule = vi.spyOn(window, 'setInterval');
  const scroller = await openWorkspace();
  await openFirstTask();
  scroller.scrollTop = 560;
  await tab('files');
  scroller.scrollTop = 110;
  await tab('tasks');
  const close = screen.getByRole('button', { name: 'common.close' });
  close.focus();
  const poll = schedule.mock.calls.find(([, delay]) => delay === 5000)?.[0];
  expect(typeof poll).toBe('function');
  const previousReads = vi.mocked(enterpriseRequest).mock.calls.length;
  await act(async () => {
    if (typeof poll === 'function') poll();
  });
  expect(vi.mocked(enterpriseRequest).mock.calls.length).toBeGreaterThan(previousReads);
  expect(scroller.scrollTop).toBe(560);
  expect(document.activeElement).toBe(close);
});

test('browser back and forward restore the appropriate section position', async () => {
  const scroller = await openWorkspace();
  await openFirstTask();
  scroller.scrollTop = 440;
  fireEvent.click(screen.getByRole('button', { name: 'Files' }));
  await screen.findByText('File list');
  scroller.scrollTop = 175;
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  await screen.findByRole('heading', { name: 'Business task A' });
  expect(scroller.scrollTop).toBe(440);
  fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
  await screen.findByText('File list');
  expect(scroller.scrollTop).toBe(175);
});

const rowCases = [
  ['Chinese business summary', { progress: '已核对本月库存。' }, '已核对本月库存。'],
  ['English business summary', { progress: 'Inventory is ready.' }, 'Inventory is ready.'],
  ['single-word summary', { progress: 'Complete' }, 'Complete'],
  ['hyphenated summary', { progress: 'Re-checked' }, 'Re-checked'],
  ['file-name summary', { progress: 'inventory_v1.xlsx' }, 'inventory_v1.xlsx'],
  [
    'known tool translation before tool filtering',
    { progress: 'read_document', steps: [{ tool: 'read_document' }] },
    'Reading document',
  ],
  ['known error translation', { progress: 'TOOL_FAILED' }, 'Tool failed'],
  ['untranslated tool from recorded steps', { progress: 'ToolSearch', steps: [{ tool: 'ToolSearch' }] }, ''],
  ['unknown snake-case tool', { progress: 'query_enterprise_data' }, ''],
  ['unknown MCP tool', { progress: 'mcp__warehouse__query' }, ''],
  ['qualified MCP tool', { progress: 'warehouse::query' }, ''],
  [
    'summary containing a tool name',
    { progress: '库存使用 query_enterprise_data 核对完成。' },
    '库存使用 query_enterprise_data 核对完成。',
  ],
  [
    'waiting question takes priority over progress',
    { state: 'waiting_input', question: '[补充] 请上传库存明细。', progress: 'read_document' },
    '[补充] 请上传库存明细。',
  ],
  [
    'confirmation question takes priority over progress',
    { state: 'waiting_confirmation', question: '[{"question":"确认本月统计口径？"}]', progress: 'read_document' },
    '确认本月统计口径？',
  ],
  ['missing progress', {}, ''],
  ['empty progress', { progress: '' }, ''],
  ['whitespace progress', { progress: '   ' }, ''],
] as const;

test.each(rowCases)(
  'task row displays %s without exposing untranslated identifiers',
  async (_name, value, expected) => {
    mockWork({ state: 'completed', ...value, steps: 'steps' in value ? [...value.steps] : [] });
    render(
      <MemoryRouter initialEntries={[taskListUrl]}>
        <WorkspaceTasks />
      </MemoryRouter>
    );
    const row = (await screen.findByText('Business task A')).closest('.arco-list-item')!;
    expect(row.querySelector('.arco-list-item-meta-description [title]')?.textContent ?? '').toBe(expected);
  }
);
