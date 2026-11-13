import { summariesForGraph } from './helpers/taskSync';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithLocale } from './helpers/renderWithLocale';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { AttachmentRecordSlots } from '../src/features/task-detail/attachments/TaskAttachments';
import type { GraphTask, Project, TaskDetail, TaskGraph } from '../src/api/types';
import { stringifyApiJson } from '../src/api/json';
import { graphFixture } from './helpers/taskDetail';
import type { GraphSnapshot } from '../src/features/projects/useTaskGraph';
import { TaskDetailDialog, type TaskDetailDialogProps } from '../src/features/task-detail/TaskDetailDialog';
import { ProjectDraftHost } from '../src/features/task-detail/TaskDraftNavigation';
import { TaskDetailSessionProvider, TaskDetailSessions, useTaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { browserNavigation } from '../src/app/navigation';
import { taskDetailUrl } from '../src/app/router';
import { useBrowserLocation } from '../src/app/browser-location';
import { projectHistory, readProjectHistory, type ProjectReading } from '../src/app/page-history';
import { dialogFocusables } from '../src/features/task-detail/focus';
import { buildGraphIndex } from '../src/features/task-graph/model';
import { TEST_VIEWER_ID, viewerHeaders, fixtureTaskEpoch } from './helpers/taskSync';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { isTopOverlay, OverlayOwnerContext, registerOverlay } from '../src/app/overlay';
import { useBodyScrollLock } from '../src/app/useBodyScrollLock';

let world: ReturnType<typeof createTaskSessionWorld>;
const snapshotDetails = new WeakMap<GraphSnapshot, readonly TaskDetail[]>();

vi.mock('../src/features/task-detail/attachments/TaskAttachments', () => ({
  TaskAttachmentsPanel: ({ projectId, taskId }: { readonly projectId: string; readonly taskId: string }) => <section aria-label="附件" data-project-id={projectId} data-task-id={taskId}><input aria-label="附件草稿" defaultValue="" /></section>,
}));
vi.mock('../src/features/task-agent-session/TaskSessionHost', async original => ({ ...await original<typeof import('../src/features/task-agent-session/TaskSessionHost')>(), ManagedSessionRecords: ({ children }: { children: (records: AttachmentRecordSlots) => ReactNode }) => children({ sidebar: null, preview: null, clearSelection: () => {} }) }));
// Detail response sequences own only task reads; Session discovery has its own API.
vi.mock('../src/api/terminal-sessions', async original => {
  const api = await original<typeof import('../src/api/terminal-sessions')>();
  return { ...api, createTerminalSessionApi: (...args: Parameters<typeof api.createTerminalSessionApi>) => ({
    ...api.createTerminalSessionApi(...args), history: async () => ({ items: [], nextCursor: null }),
  }) };
});
vi.mock('../src/features/task-detail/attachments/useAttachments', () => ({ useAttachments: () => ({ select: vi.fn() }) }));

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const projectId = id(100);
const timestamp = '2026-10-20T09:00:00.123456789Z';
const project: Project = { ownership: { teamId: '00000000-0000-4000-8000-000000000701', version: 1n }, settings: { version: 1n, executionWarningMinutes: 60 }, id: projectId, name: '测试项目', repoUrl: 'https://github.com/example/project', createdAt: timestamp, updatedAt: timestamp };
const detail = (value = 1, changes: Partial<TaskDetail> = {}): TaskDetail => ({ tags: [], type: 'task', parentId: null, assignedTo: null, requiredPlatform: null, allowAgents: false, externalDependsOn: [], startedAt: null, completedAt: null, cancelledAt: null,
  id: id(value), projectId, title: `任务 ${value}`, description: `任务 ${value} 的完整描述`, status: 'todo', version: 1n,
  properties: { pullRequests: [] }, dependsOn: [], blockedBy: [], ready: true, createdAt: timestamp, updatedAt: timestamp, ...changes,
});
const node = (task: TaskDetail): GraphTask => ({ type: task.type, parentId: task.parentId, assignedTo: task.assignedTo, requiredPlatform: task.requiredPlatform, allowAgents: task.allowAgents, startedAt: task.startedAt, completedAt: task.completedAt, cancelledAt: task.cancelledAt,
  id: task.id, titlePreview: Array.from(task.title).slice(0, 160).join(''), titleTruncated: Array.from(task.title).length > 160,
  status: task.status, dependsOn: task.dependsOn, externalDependsOn: task.externalDependsOn, blockedBy: task.blockedBy, ready: task.ready, createdAt: task.createdAt, updatedAt: task.updatedAt,
});
const snapshot = (tasks = [detail()], revision = 1): GraphSnapshot => {
  const graph: TaskGraph = { observedAt: "2026-10-20T12:00:00Z",
    project, tasks: tasks.map(node), summary: { proposed: 0,
      total: tasks.length, todo: tasks.filter((task) => task.status === 'todo').length,
      inProgress: tasks.filter((task) => task.status === 'in_progress').length,
      done: tasks.filter((task) => task.status === 'done').length, cancelled: 0,
      ready: tasks.filter((task) => task.ready).length,
      blocked: tasks.filter((task) => task.status === 'todo' && !task.ready).length,
    },
  };
  const value = { observedAt: graph.observedAt, graph, index: buildGraphIndex(graph), summaries: summariesForGraph(graph), workerMachines: new Map(), pausedTaskIds: new Set<string>(), receivedMonotonic: performance.now(), receivedAt: Date.now(), revision };
  snapshotDetails.set(value, tasks);
  return value;
};
const response = (task: TaskDetail) => new Response(stringifyApiJson(task), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json', 'Daynight-Task-Epoch': fixtureTaskEpoch(task.projectId) }) });
const failure = (code = 'internal_error') => new Response(JSON.stringify({ error: {
  code, message: 'private database password', requestId: 'task-detail-request-123',
} }), { status: code === 'not_found' ? 404 : 500, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};

let root: HTMLDivElement;
let host: HTMLDivElement;
let trigger: HTMLButtonElement;
const props = (changes: Partial<TaskDetailDialogProps> = {}): TaskDetailDialogProps => ({
  projectId, taskId: id(1), snapshot: snapshot(), onSelectTask: vi.fn(), onClose: vi.fn(),
  onRestoreFocus: () => trigger.focus(), onRefreshGraph: vi.fn(), ...changes,
});
const open = async (options = props(), locale: 'en' | 'zh-CN' = 'zh-CN') => {
  await world.sync(snapshotDetails.get(options.snapshot!)!);
  const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale, container: host, taskCache: { scope: world.scope } });
  return { ...view, rerender: async (ui: ReactElement<TaskDetailDialogProps>) => {
    await world.sync(snapshotDetails.get(ui.props.snapshot!)!);
    view.rerender(ui);
  } };
};

beforeEach(() => {
  world = createTaskSessionWorld();
  root = document.createElement('div');
  root.id = 'root';
  host = document.createElement('div');
  trigger = document.createElement('button');
  trigger.textContent = '原任务节点';
  root.append(trigger, host);
  document.body.append(root);
  trigger.focus();
});
afterEach(() => { cleanup(); world.dispose(); root.remove(); document.body.style.overflow = ''; });

describe('task detail dialog', () => {
  it('shows the actual parent as a read-only overview link and updates its summary', async () => {
    const child = detail(1, { parentId: id(2) });
    const goal = detail(2, { type: 'goal', title: 'A'.repeat(161), ready: true });
    const current = snapshot([child, goal]);
    const fetcher = vi.fn().mockResolvedValue(response(child));
    vi.stubGlobal('fetch', fetcher);
    const options = props({ snapshot: current });
    const view = await open(options, 'en');
    const aside = await screen.findByRole('complementary', { name: 'Task relationships and metadata' });
    const section = within(aside).getByRole('region', { name: 'Current Goal' });
    expect(aside.firstElementChild).toBe(section);
    const link = within(section).getByRole('link', { name: `${'A'.repeat(160)}…` });
    expect(link).toHaveAttribute('href', taskDetailUrl(projectId, goal.id, { tab: 'overview', path: null }));
    expect(screen.queryByRole('combobox', { name: 'Current Goal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save Goal membership' })).toBeNull();
    const renamed = snapshot([child, { ...goal, title: 'Renamed Goal', version: 2n, updatedAt: '2026-10-20T09:00:01Z' }], 2);
    await view.rerender(<TaskDetailDialog {...options} snapshot={renamed} />);
    expect(within(section).getByRole('link', { name: 'Renamed Goal' })).toHaveAttribute('href', link.getAttribute('href'));
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    expect(screen.queryByRole('region', { name: 'Current Goal' })).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => options?.method === undefined || options.method === 'GET')).toBe(true);
  });

  it('uses the parent ID when a Goal summary is absent or not a Goal, and shows a plain empty state', async () => {
    const child = detail(1, { parentId: id(2) });
    const other = detail(2, { title: 'Not a Goal' });
    const current = snapshot([child, other]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(child)));
    const options = props({ snapshot: current, observation: { kind: 'direct' } });
    await world.sync([child, other]);
    const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    const section = await screen.findByRole('region', { name: 'Current Goal' });
    expect(within(section).getByRole('link', { name: other.id })).toHaveAttribute('href', taskDetailUrl(projectId, other.id, { tab: 'overview', path: null }));
    view.rerender(<TaskDetailDialog {...options} snapshot={null} graphError={new Error('graph unavailable')} />);
    expect(within(section).getByRole('link', { name: other.id })).toBeVisible();
  });

  it('renders an unassigned Task without a Goal link or editing control', async () => {
    const child = detail();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(child)));
    await open(props({ snapshot: snapshot([child]) }), 'en');
    const section = await screen.findByRole('region', { name: 'Current Goal' });
    expect(within(section).getByText('No Goal')).toBeVisible();
    expect(within(section).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Current Goal' })).toBeNull();
  });

  it('waits for a summary receipt when restoring a Task before the graph and keeps its reader through a missing snapshot', async () => {
    const reviewed = detail();
    await world.sync([reviewed]);
    const directRead = vi.spyOn(world.scope, 'beginTaskRead');
    const fetcher = vi.fn().mockResolvedValue(response(reviewed));
    vi.stubGlobal('fetch', fetcher);
    const loading = props({ snapshot: null, observation: { kind: 'project-summary', revision: 0, task: undefined } });
    const view = renderWithLocale(<TaskDetailDialog {...loading} />, { locale: 'zh-CN', container: host, taskCache: { scope: world.scope } });
    expect(screen.getByRole('dialog')).toHaveTextContent('正在加载任务详情');
    expect(directRead).not.toHaveBeenCalled();
    const preview = snapshot([reviewed], 0);
    view.rerender(<TaskDetailDialog {...loading} snapshot={preview} observation={{ kind: 'project-summary', revision: 0, task: preview.index.nodes.get(reviewed.id) }} />);
    expect(directRead).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('正在加载任务详情');
    const current = snapshot([reviewed], 1);
    view.rerender(<TaskDetailDialog {...loading} snapshot={current} observation={{ kind: 'project-summary', revision: 1, task: current.index.nodes.get(reviewed.id) }} />);
    await screen.findByRole('heading', { name: reviewed.title });
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const reader = screen.getByRole('textbox', { name: '附件草稿' });
    fireEvent.change(reader, { target: { value: 'retained' } });
    view.rerender(<TaskDetailDialog {...loading} />);
    expect(screen.getByRole('textbox', { name: '附件草稿' })).toBe(reader);
    expect(reader).toHaveValue('retained');
    expect(directRead).not.toHaveBeenCalled();
  });

  it('keeps an already admitted summary Task reader when the Project snapshot is temporarily unavailable', async () => {
    const reviewed = detail();
    await world.sync([reviewed]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reviewed)));
    const current = snapshot([reviewed], 1);
    const options = props({ snapshot: current, observation: { kind: 'project-summary', revision: 1, task: current.index.nodes.get(reviewed.id) } });
    const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale: 'zh-CN', container: host, taskCache: { scope: world.scope } });
    await screen.findByRole('heading', { name: reviewed.title });
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const reader = screen.getByRole('textbox', { name: '附件草稿' });
    fireEvent.change(reader, { target: { value: 'keep existing reader' } });
    view.rerender(<TaskDetailDialog {...options} snapshot={null} observation={{ kind: 'project-summary', revision: 0, task: undefined }} />);
    expect(screen.getByRole('textbox', { name: '附件草稿' })).toBe(reader);
    expect(reader).toHaveValue('keep existing reader');
  });

  it.each(['identity', 'history'] as const)('retains a real Goal edit across source changes until %s retirement', async retirement => {
    const goal = detail(1, { type: 'goal', title: 'Goal draft', description: 'Original', ready: false });
    await world.sync([goal]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(goal)));
    history.replaceState(null, '', `/projects/${projectId}`);
    const navigation = browserNavigation();
    const initial: ProjectReading = { section: 'tasks', view: 'goals', projectGraphWitness: null, detail: { id: goal.id, source: 'direct', insideProjectGraph: false,
      navigation: { tab: 'overview', path: null }, goalChildren: null } };
    navigation.setView(projectHistory(TEST_VIEWER_ID, projectId, initial), { replace: true });
    const Harness = () => {
      const location = useBrowserLocation();
      const selected = readProjectHistory(location.view, TEST_VIEWER_ID, projectId)!.detail!;
      return <ProjectDraftHost projectId={projectId} taskId={goal.id} source={selected.source} summaryType={undefined} insideProjectGraph={false} graphWitness={null}>
        <TaskDetailDialog {...props({ taskId: goal.id, snapshot: null, observation: selected.source === 'direct' ? { kind: 'direct' } : { kind: 'project-summary', revision: 0, task: undefined } })} />
      </ProjectDraftHost>;
    };
    const view = renderWithLocale(<Harness />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    const edit = await screen.findByRole('button', { name: 'Edit' });
    await waitFor(() => expect(edit).toBeEnabled());
    fireEvent.click(edit);
    const editor = screen.getByRole('textbox', { name: 'Description' });
    fireEvent.change(editor, { target: { value: 'Keep Goal changes' } });
    // Ordinary cache changes may advance the project revision without retiring history.
    const revision = world.scope.getProjectRevision(projectId);
    const revisionRead = vi.spyOn(world.scope, 'getProjectRevision').mockReturnValue(revision + 1);
    view.rerender(<Harness />);
    expect(screen.getByRole('textbox', { name: 'Description' })).toBe(editor);
    revisionRead.mockRestore();
    const summary: ProjectReading = { ...initial, detail: { ...initial.detail!, source: 'summary' } };
    act(() => navigation.setView(projectHistory(TEST_VIEWER_ID, projectId, summary)));
    expect(screen.queryByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Description' })).toBe(editor);
    expect(editor).toHaveValue('Keep Goal changes');
    act(() => navigation.setView(projectHistory(TEST_VIEWER_ID, projectId, initial)));
    expect(screen.getByRole('textbox', { name: 'Description' })).toBe(editor);
    expect(editor).toHaveValue('Keep Goal changes');
    act(() => {
      if (retirement === 'identity') world.scope.dispose();
      else world.scope.retireGoalHistory(projectId, fixtureTaskEpoch(projectId));
    });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull());
  });

  it.each(['summary', 'direct'] as const)('keeps an admitted %s Goal child through a missing graph, recovery and history retirement', async (source) => {
    const goal = detail(1, { type: 'goal', title: 'Parent Goal', ready: false });
    const child = detail(2, { parentId: goal.id, title: 'Child task' });
    await world.sync([goal, child]);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes(child.id) ? child : goal)));
    const project = world.scope.getAuthorizedProject(projectId)!;
    const current = { ...snapshot([detail()], 1), graph: project.graph, index: project.index, summaries: project.summaries };
    const goalOnly = graphFixture([goal]);
    const withoutChild = { ...current, graph: goalOnly, index: buildGraphIndex(goalOnly), summaries: summariesForGraph(goalOnly) };
    const initialGraph = source === 'summary' ? current : withoutChild;
    const options = props({ taskId: goal.id, snapshot: initialGraph, observation: { kind: 'direct' }, goalChildren: { graphRootId: null,
      task: { id: child.id, navigation: { tab: 'attachments', path: null } } }, onGoalChildrenChange: vi.fn() });
    const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    await screen.findByRole('heading', { name: child.title });
    const reader = screen.getByRole('textbox', { name: '附件草稿' });
    fireEvent.change(reader, { target: { value: 'child reading state' } });
    view.rerender(<TaskDetailDialog {...options} snapshot={null} />);
    expect(screen.getByRole('textbox', { name: '附件草稿' })).toBe(reader);
    expect(reader).toHaveValue('child reading state');
    view.rerender(<TaskDetailDialog {...options} snapshot={current} />);
    expect(screen.getByRole('textbox', { name: '附件草稿' })).toBe(reader);
    expect(reader).toHaveValue('child reading state');
    act(() => world.scope.retireGoalHistory(projectId, fixtureTaskEpoch(projectId)));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '附件草稿' })).toBeNull());
  });

  it('selects summary admission only after a restored Goal child becomes eligible', async () => {
    const goal = detail(1, { type: 'goal', title: 'Parent Goal', ready: false });
    const child = detail(2, { parentId: goal.id, title: 'Eligible child' });
    await world.sync([goal, child]);
    const directRead = vi.spyOn(world.scope, 'beginTaskRead');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes(child.id) ? child : goal)));
    const options = props({ taskId: goal.id, snapshot: null, observation: { kind: 'direct' }, goalChildren: { graphRootId: null,
      task: { id: child.id, navigation: { tab: 'overview', path: null } } }, onGoalChildrenChange: vi.fn() });
    const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    await screen.findByRole('heading', { name: goal.title });
    expect(screen.queryByRole('heading', { name: child.title })).toBeNull();
    const project = world.scope.getAuthorizedProject(projectId)!;
    const current = { ...snapshot([detail()], 1), graph: project.graph, index: project.index, summaries: project.summaries };
    view.rerender(<TaskDetailDialog {...options} snapshot={current} />);
    await screen.findByRole('heading', { name: child.title });
    expect(directRead.mock.calls.filter(([, id]) => id === child.id)).toHaveLength(0);
  });

  it('does not use a retired graph Goal to start a direct read for a summary selection', async () => {
    const goal = detail(1, { type: 'goal', title: 'Retired Goal', ready: false });
    await world.sync([goal]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(goal)));
    const project = world.scope.getAuthorizedProject(projectId)!;
    const current = { ...snapshot([detail()], 1), graph: project.graph, index: project.index, summaries: project.summaries };
    const options = props({ taskId: goal.id, snapshot: current, observation: { kind: 'direct' } });
    const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    await screen.findByRole('heading', { name: goal.title });
    const direct = vi.spyOn(TaskDetailSessions.prototype, 'openDirect');
    act(() => {
      world.scope.retireGoalHistory(projectId, fixtureTaskEpoch(projectId));
      view.rerender(<TaskDetailDialog {...options} observation={{ kind: 'project-summary', revision: 1, task: current.index.nodes.get(goal.id) }} />);
    });
    expect(screen.queryByRole('heading', { name: goal.title })).toBeNull();
    expect(direct).not.toHaveBeenCalled();
  });

  it.each(['direct', 'project-summary'] as const)('loads actual Steps across %s and the other Task observation source', async initialSource => {
    const reviewed = detail();
    await world.sync([reviewed]);
    let stepsReads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/steps')) {
        stepsReads++;
        return new Response(stringifyApiJson({ projectId, taskId: reviewed.id, version: reviewed.version,
          steps: [{ id: '00000001', title: 'Actual step', description: '', status: 'todo', createdAt: '2026-10-20T09:00:00Z', updatedAt: '2026-10-20T09:00:00Z' }] }),
          { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
      }
      return response(reviewed);
    });
    vi.stubGlobal('fetch', fetcher);
    const current = snapshot([reviewed], 1);
    const options = props({ snapshot: current, navigation: { tab: 'steps', path: null }, onNavigate: vi.fn() });
    const observation = (kind: 'direct' | 'project-summary') => kind === 'direct' ? { kind: 'direct' as const }
      : { kind: 'project-summary' as const, revision: current.revision, task: current.index.nodes.get(reviewed.id) };
    const view = renderWithLocale(<TaskDetailDialog {...options} observation={observation(initialSource)} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    await screen.findByText('Actual step');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add step' })).toBeEnabled());
    const firstReads = stepsReads;
    const otherSource = initialSource === 'direct' ? 'project-summary' : 'direct';
    view.rerender(<TaskDetailDialog {...options} observation={observation(otherSource)} />);
    await waitFor(() => expect(stepsReads).toBeGreaterThan(firstReads));
    await screen.findByText('Actual step');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add step' })).toBeEnabled());
    const secondReads = stepsReads;
    view.rerender(<TaskDetailDialog {...options} observation={observation(initialSource)} />);
    await waitFor(() => expect(stepsReads).toBeGreaterThan(secondReads));
    await screen.findByText('Actual step');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add step' })).toBeEnabled());
  });

  it('waits for the live summary receipt and ignores a late direct response after changing source', async () => {
    const reviewed = detail();
    const old = detail(1, { title: 'Late direct response' });
    await world.sync([reviewed]);
    const pending = deferred<Response>();
    let detailReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith(`/tasks/${reviewed.id}`)) return ++detailReads === 1 ? pending.promise : Promise.resolve(response(reviewed));
      return Promise.resolve(response(reviewed));
    }));
    const current = snapshot([reviewed], 1);
    const options = props({ snapshot: current, observation: { kind: 'direct' } });
    const view = renderWithLocale(<TaskDetailDialog {...options} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    await waitFor(() => expect(detailReads).toBe(1));
    const preview = snapshot([reviewed], 0);
    view.rerender(<TaskDetailDialog {...options} snapshot={preview} observation={{ kind: 'project-summary', revision: 0, task: preview.index.nodes.get(reviewed.id) }} />);
    expect(screen.queryByRole('heading', { name: reviewed.title })).toBeNull();
    expect(detailReads).toBe(1);
    view.rerender(<TaskDetailDialog {...options} observation={{ kind: 'project-summary', revision: 1, task: current.index.nodes.get(reviewed.id) }} />);
    await screen.findByRole('heading', { name: reviewed.title });
    await act(async () => { pending.resolve(response(old)); await pending.promise; });
    expect(screen.queryByRole('heading', { name: old.title })).toBeNull();
    expect(screen.getByRole('heading', { name: reviewed.title })).toBeVisible();
  });

  it.each([['direct', 'pending'], ['direct', 'unknown'], ['project-summary', 'pending'], ['project-summary', 'unknown']] as const)('does not replay a %s Task write while %s when switching source', async (source, phase) => {
    const reviewed = detail();
    await world.sync([reviewed]);
    const write = deferred<Response>();
    const recovery = deferred<Response>();
    let writes = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') { writes++; return write.promise; }
      if (phase === 'unknown' && writes !== 0 && String(input).endsWith(`/tasks/${reviewed.id}`)) return recovery.promise.then(value => value.clone());
      return Promise.resolve(response(reviewed));
    }));
    let session!: TaskDetailSessions;
    const Capture = () => { session = useTaskDetailSessions(); return null; };
    const current = snapshot([reviewed], 1);
    const options = props({ snapshot: current });
    const content = (source: 'direct' | 'project-summary') => <TaskDetailSessionProvider><Capture /><TaskDetailDialog {...options}
      observation={source === 'direct' ? { kind: 'direct' } : { kind: 'project-summary', revision: 1, task: current.index.nodes.get(reviewed.id) }} /></TaskDetailSessionProvider>;
    const view = renderWithLocale(content(source), { locale: 'en', container: host, taskCache: { scope: world.scope } });
    await screen.findByRole('heading', { name: reviewed.title });
    await waitFor(() => expect(source === 'direct' ? session.directRequiresFreshRead(projectId, reviewed.id) : session.requiresFreshRead(projectId, reviewed.id, current.index.nodes.get(reviewed.id))).toBe(false));
    act(() => session.setStatus(projectId, reviewed.id, 'in_progress', reviewed.version));
    await waitFor(() => expect(writes).toBe(1));
    if (phase === 'unknown') {
      await act(async () => { write.reject(new TypeError('Response lost')); await write.promise.catch(() => {}); });
      await waitFor(() => expect(session.snapshot(projectId, reviewed.id).mutation.phase).toBe('unknown'));
    }
    view.rerender(content(source === 'direct' ? 'project-summary' : 'direct'));
    if (phase === 'pending') await waitFor(() => expect(session.snapshot(projectId, reviewed.id).detail?.title).toBe(reviewed.title));
    act(() => session.setStatus(projectId, reviewed.id, 'in_progress', reviewed.version));
    expect(writes).toBe(1);
    if (phase === 'pending') await act(async () => { write.reject(new TypeError('Response lost')); await write.promise.catch(() => {}); });
    view.unmount();
    recovery.resolve(response(reviewed));
  });

  it('continues a direct Task read when there is no Project graph', async () => {
    const reviewed = detail();
    await world.sync([reviewed]);
    const directRead = vi.spyOn(world.scope, 'beginTaskRead');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reviewed)));
    renderWithLocale(<TaskDetailDialog {...props({ snapshot: null, observation: { kind: 'direct' } })} />, { locale: 'zh-CN', container: host, taskCache: { scope: world.scope } });
    await screen.findByRole('heading', { name: reviewed.title });
    expect(directRead).toHaveBeenCalled();
  });

  it('admits a summary Goal through the typed reader after its graph identifies the Goal', async () => {
    const reviewed = detail(1, { type: 'goal', title: 'Goal preview', ready: false });
    await world.sync([reviewed]);
    const directRead = vi.spyOn(world.scope, 'beginTaskRead');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reviewed)));
    const loading = props({ snapshot: null, observation: { kind: 'project-summary', revision: 0, task: undefined } });
    const view = renderWithLocale(<TaskDetailDialog {...loading} />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    expect(directRead).not.toHaveBeenCalled();
    const project = world.scope.getAuthorizedProject(projectId)!;
    const preview = { ...snapshot([detail()], 0), graph: project.graph, index: project.index, summaries: project.summaries };
    view.rerender(<TaskDetailDialog {...loading} snapshot={preview} observation={{ kind: 'project-summary', revision: 0, task: preview.index.nodes.get(reviewed.id) }} />);
    const heading = await screen.findByRole('heading', { name: reviewed.title });
    expect(directRead).toHaveBeenCalled();
    const dialog = heading.closest('[role="dialog"]');
    view.rerender(<TaskDetailDialog {...loading} />);
    expect(screen.getByRole('heading', { name: reviewed.title }).closest('[role="dialog"]')).toBe(dialog);
  });

  it('gives a nested task portal keyboard ownership and restores its parent focus and scroll lock', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(detail())));
    await world.sync([detail()]);
    document.body.style.overflow = 'scroll';
    const parentKey = vi.fn();
    const Parent = () => {
      const owner = useRef<HTMLElement>(null);
      const opener = useRef<HTMLButtonElement>(null);
      const [openChild, setOpenChild] = useState(false);
      useBodyScrollLock(true);
      useLayoutEffect(() => {
        const element = owner.current!;
        const release = registerOverlay(element, root);
        const keydown = (event: KeyboardEvent) => {
          if (isTopOverlay(element) && (event.key === 'Escape' || event.key === 'Tab')) {
            parentKey(event.key);
            event.preventDefault();
          }
        };
        document.addEventListener('keydown', keydown);
        return () => { document.removeEventListener('keydown', keydown); release(); };
      }, []);
      return <OverlayOwnerContext value={owner}>
        <section ref={owner} aria-label="Parent layer"><button ref={opener} onClick={() => setOpenChild(true)}>Open child</button></section>
        {openChild && <TaskDetailDialog {...props()} onClose={() => setOpenChild(false)} onRestoreFocus={() => opener.current?.focus()} />}
      </OverlayOwnerContext>;
    };
    const view = renderWithLocale(<Parent />, { locale: 'en', container: host, taskCache: { scope: world.scope } });
    const parent = screen.getByRole('region', { name: 'Parent layer' });
    const opener = screen.getByRole('button', { name: 'Open child' });
    opener.focus(); fireEvent.click(opener);
    await screen.findByRole('heading', { name: '任务 1' });
    const child = screen.getByRole('dialog');
    expect(parent).toHaveAttribute('inert');
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    const focusables = dialogFocusables(child);
    const first = focusables[0]!, last = focusables[focusables.length - 1]!;
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    first.focus(); fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    expect(parentKey).not.toHaveBeenCalled();
    fireEvent.keyDown(last, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(parentKey).not.toHaveBeenCalled();
    expect(parent).not.toHaveAttribute('inert');
    expect(opener).toHaveFocus();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(opener, { key: 'Escape' });
    expect(parentKey).toHaveBeenCalledExactlyOnceWith('Escape');
    view.unmount();
    expect(root).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('scroll');
  });
  it('keeps discard confirmation above the modal detail focus owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/steps')
      ? new Response(stringifyApiJson({ projectId, taskId: id(1), version: 1n, steps: [] }), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) })
      : response(detail())));
    await open(props(), 'en');
    await screen.findByRole('heading', { name: '任务 1' });
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add step' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const confirmation = screen.getByRole('alertdialog');
    const keep = within(confirmation).getByRole('button', { name: 'Keep editing' });
    const discard = within(confirmation).getByRole('button', { name: 'Discard' });
    expect(keep).toHaveFocus();
    expect(document.querySelector('.task-detail-dialog')).toHaveAttribute('inert');
    await userEvent.tab(); expect(discard).toHaveFocus();
    await userEvent.tab({ shift: true }); expect(keep).toHaveFocus();
    fireEvent.click(keep);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Draft');
    expect(document.querySelector('.task-detail-dialog')).not.toHaveAttribute('inert');
  });
  it('copies the complete title independently of the ID and reports a localized failure with retry', async () => {
    const reviewed = detail(1, { title: `${'完整标题 & <文本> 🧩 '.repeat(30)}\n结尾` });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reviewed)));
    const writeText = vi.fn().mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError')).mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const view = await open(props({ snapshot: snapshot([reviewed]) }), 'en');
    const copy = await screen.findByRole('button', { name: 'Copy task title' });
    expect(copy.closest('.task-detail-title-row')).toContainElement(screen.getByRole('heading', { level: 2 }));
    expect(copy).toHaveAttribute('title', 'Copy task title');
    fireEvent.click(copy);
    expect(await screen.findByText('Could not copy the task title. Select and copy it manually.')).toBeVisible();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(reviewed.title);
    expect(screen.getByRole('heading', { level: 2 })).toHaveAttribute('title', reviewed.title);
    view.setLocale('zh-CN');
    expect(screen.getByText('无法复制任务标题，请选中并手动复制。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '复制任务标题' }));
    expect(await screen.findByText('已复制')).toBeVisible();
    expect(writeText).toHaveBeenLastCalledWith(reviewed.title);
    fireEvent.click(screen.getByRole('button', { name: '复制任务 ID' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(reviewed.id));
  });

  it('hides title copy during loading and discards a pending result after task navigation', async () => {
    const read = deferred<Response>();
    const copied = deferred<void>();
    const fetch = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(response(detail(2)));
    vi.stubGlobal('fetch', fetch);
    const writeText = vi.fn().mockReturnValue(copied.promise);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const options = props();
    const view = await open(options);
    expect(screen.queryByRole('button', { name: '复制任务标题' })).toBeNull();
    read.resolve(response(detail()));
    const copy = await screen.findByRole('button', { name: '复制任务标题' });
    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(copy).toBeDisabled();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('任务 1');
    await view.rerender(<TaskDetailDialog {...options} taskId={id(2)} snapshot={snapshot([detail(2)], 2)} />);
    await screen.findByRole('heading', { name: '任务 2' });
    await act(async () => copied.resolve());
    expect(screen.queryByText('已复制')).toBeNull();
    expect(screen.getByRole('button', { name: '复制任务标题' })).toBeEnabled();
  });

  it('resizes the same reading workspace, preserves drafts and offsets, and dismisses one layer per Escape', async () => {
    const fetch = vi.fn().mockResolvedValue(response(detail()));
    vi.stubGlobal('fetch', fetch);
    const options = props();
    const view = await open(options);
    await screen.findByRole('heading', { name: '任务 1' });
    const shell = screen.getByRole('dialog');
    const overview = screen.getByRole('tabpanel', { name: '概览' });
    const reading = shell.querySelector('.task-detail-panels');
    const title = screen.getByRole('heading', { name: '任务 1' });
    const more = screen.getByRole('button', { name: '更多任务操作' });
    fireEvent.click(more);
    const popout = screen.getByRole('menuitem', { name: '在新标签页打开' });
    expect(popout).toHaveAttribute('target', '_blank');
    fireEvent.keyDown(popout, { key: 'Escape' });
    overview.scrollTop = 470;
    title.scrollLeft = 19;
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const draft = screen.getByLabelText('附件草稿');
    fireEvent.change(draft, { target: { value: 'retained upload path' } });
    const toggle = screen.getByRole('button', { name: '进入全屏' });
    fireEvent.click(toggle);
    expect(shell).toHaveClass('task-detail-fullscreen');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('dialog')).toBe(shell);
    expect(shell.querySelector('.task-detail-panels')).toBe(reading);
    expect(screen.getByRole('button', { name: '更多任务操作' })).toBe(more);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(dialogFocusables(shell)).toContain(more);
    expect(dialogFocusables(shell)).toContain(title);
    expect(overview.scrollTop).toBe(470);
    expect(title.scrollLeft).toBe(19);
    expect(screen.getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('附件草稿')).toBe(draft);
    expect(draft).toHaveValue('retained upload path');
    expect(fetch).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shell).not.toHaveClass('task-detail-fullscreen');
    expect(toggle).toHaveFocus();
    expect(options.onClose).not.toHaveBeenCalled();
    expect(root).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(options.onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    cleanup();
    await open(options);
    expect(screen.getByRole('dialog')).not.toHaveClass('task-detail-fullscreen');
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('lets menus, status and deletion confirmations consume Escape before leaving fullscreen', async () => {
    const fetch = vi.fn().mockResolvedValue(response(detail()));
    vi.stubGlobal('fetch', fetch);
    const options = props();
    await open(options);
    await screen.findByRole('heading', { name: '任务 1' });
    const shell = screen.getByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '进入全屏' }));
    fireEvent.click(screen.getByRole('button', { name: '待处理' }));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(shell).toHaveClass('task-detail-fullscreen');
    fireEvent.click(screen.getByRole('button', { name: '待处理' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '进行中' }));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(shell).toHaveClass('task-detail-fullscreen');
    const more = screen.getByRole('button', { name: '更多任务操作' });
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(shell).toHaveClass('task-detail-fullscreen');
    expect(more).toHaveFocus();
    fireEvent.click(more);
    const deletion = screen.getByRole('menuitem', { name: '删除任务' });
    deletion.focus();
    fireEvent.click(deletion);
    expect(screen.getByRole('alertdialog', { name: '删除并解除依赖？' })).toHaveTextContent('普通和外部依赖');
    expect(shell).toHaveAttribute('inert');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(shell).not.toHaveAttribute('inert');
    expect(shell).toHaveClass('task-detail-fullscreen');
    expect(more).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(shell).not.toHaveClass('task-detail-fullscreen');
    expect(options.onClose).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('retranslates a to-do task and its unfinished to-do prerequisite without a ready badge or refetch', async () => {
    const prerequisite = detail(2, { status: 'todo', ready: true });
    const reviewed = detail(1, { status: 'todo', dependsOn: [id(2)], blockedBy: [id(2)], ready: false });
    const fetch = vi.fn().mockResolvedValue(response(reviewed));
    vi.stubGlobal('fetch', fetch);
    const options = props({ snapshot: snapshot([reviewed, prerequisite]) });
    const view = await open(options, 'en');
    await screen.findByRole('heading', { name: '任务 1' });
    const original = screen.getByRole('dialog', { name: reviewed.title });
    expect(within(original).getByRole('heading', { level: 2, name: reviewed.title }).closest('.task-detail-header')).not.toBeNull();
    expect(original.querySelector('.task-detail-heading')).not.toHaveTextContent(reviewed.id);
    expect(original.querySelector('.task-detail-heading .task-detail-title')).toBeNull();
    expect(within(original).getAllByText(reviewed.id)).toHaveLength(1);
    expect(within(original).getByRole('button', { name: 'Copy task ID' })).toBeVisible();
    expect(within(original).getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
    expect(within(original).getByRole('button', { name: 'To do' })).toHaveClass('task-status-trigger');
    expect(within(original).queryByText('Ready')).toBeNull();
    expect(within(original).queryByRole('combobox', { name: '语言 / Language' })).toBeNull();
    view.setLocale('zh-CN');
    const dialog = screen.getByRole('dialog', { name: reviewed.title });
    expect(dialog).toBe(original);
    expect(within(dialog).getByRole('button', { name: '待处理' })).toHaveClass('task-status-trigger');
    expect(within(dialog).queryByText('可开始')).toBeNull();
    const relation = within(screen.getByRole('region', { name: '当前未完成的前置' })).getByRole('button', { name: /^任务 2，普通依赖$/ });
    expect(relation.querySelector('.task-detail-relation-dot')).toHaveClass('task-detail-dot-todo');
    fireEvent.click(relation);
    expect(options.onSelectTask).toHaveBeenCalledWith(id(2));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
    view.unmount();
    expect(trigger).toHaveFocus();
  });

  it('classifies predecessors and successors using each dependency edge owner', async () => {
    const ordinary = detail(1, { status: 'todo', ready: true });
    const external = detail(2, { status: 'todo', ready: true });
    const selected = detail(3, { status: 'todo', dependsOn: [ordinary.id, external.id],
      externalDependsOn: [external.id], blockedBy: [ordinary.id, external.id], ready: false });
    const nextOrdinary = detail(4, { status: 'todo', dependsOn: [selected.id], blockedBy: [selected.id], ready: false });
    const nextExternal = detail(5, { status: 'todo', dependsOn: [selected.id], externalDependsOn: [selected.id], blockedBy: [selected.id], ready: false });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(selected)));
    const options = props({ taskId: selected.id, snapshot: snapshot([ordinary, external, selected, nextOrdinary, nextExternal]) });
    const view = await open(options); await screen.findByRole('heading', { name: '任务 3' });
    const predecessors = screen.getByRole('region', { name: '前置依赖' });
    const blockers = screen.getByRole('region', { name: '当前未完成的前置' });
    const successors = screen.getByRole('region', { name: '任务图快照中的直接后续' });
    for (const region of [predecessors, blockers]) {
      const normal = within(region).getByRole('button', { name: /任务 1.*普通依赖/ });
      const marked = within(region).getByRole('button', { name: /任务 2.*外部依赖/ });
      expect(normal.querySelector('.task-detail-relation-kind')).toHaveTextContent('普通依赖');
      expect(normal.querySelector('.task-detail-relation-external')).toBeNull();
      expect(marked.querySelector('.task-detail-relation-external')).toHaveTextContent('外部依赖');
    }
    expect(within(successors).getByRole('button', { name: /任务 4.*普通依赖/ }).querySelector('.task-detail-relation-external')).toBeNull();
    const externalSuccessor = within(successors).getByRole('button', { name: /任务 5.*外部依赖/ });
    expect(externalSuccessor.querySelector('.task-detail-relation-external')).toHaveTextContent('外部依赖');
    fireEvent.click(externalSuccessor);
    expect(options.onSelectTask).toHaveBeenCalledWith(nextExternal.id);
    const changed = snapshot([ordinary, external, selected,
      { ...nextOrdinary, externalDependsOn: [selected.id], version: nextOrdinary.version + 1n }, { ...nextExternal, externalDependsOn: [], version: nextExternal.version + 1n }], 2);
    await view.rerender(<TaskDetailDialog {...options} snapshot={changed} />);
    expect(within(successors).getByRole('button', { name: /任务 4.*外部依赖/ })).toBeVisible();
    expect(within(successors).getByRole('button', { name: /任务 5.*普通依赖/ })).toBeVisible();
    expect(within(predecessors).getByRole('button', { name: /任务 2.*外部依赖/ })).toBeVisible();
  });

  it('opens on overview and keeps task-scoped attachments in their own mounted panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(detail())));
    await open();
    await screen.findByRole('heading', { name: '任务 1' });
    const overview = screen.getByRole('tabpanel', { name: '概览' });
    const pullRequests = screen.getAllByRole('region', { name: '关联 PR' });
    const aside = screen.getByRole('complementary', { name: '任务关系与元数据' });
    const main = overview.querySelector('.task-detail-main')!;
    const dependencies = within(aside).getByRole('region', { name: '前置依赖' });
    expect(pullRequests).toHaveLength(1);
    expect(main).not.toContainElement(pullRequests[0]!);
    expect(overview).toContainElement(aside);
    expect(aside).toContainElement(pullRequests[0]!);
    expect(pullRequests[0]!.compareDocumentPosition(dependencies) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('region', { name: '附件' })).toBeNull();
    const attachments = document.querySelector('[data-task-id]')!;
    expect(attachments).toHaveAttribute('data-project-id', projectId);
    expect(attachments).toHaveAttribute('data-task-id', id(1));
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    expect(screen.getByRole('tabpanel', { name: '附件' })).toContainElement(attachments as HTMLElement);
    expect(screen.getByRole('region', { name: '附件' })).toBe(attachments);
    expect(overview).toHaveAttribute('hidden');
    expect(overview).toHaveAttribute('inert');
  });

  it('loads real detail outside the inert application, locks scrolling, and restores focus on close', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    document.body.style.overflow = 'scroll';
    const view = await open();
    const dialog = screen.getByRole('dialog');
    expect(root.contains(dialog)).toBe(false);
    expect(root.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByRole('status')).toHaveAccessibleName('正在加载任务详情');
    expect(screen.getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
    await waitFor(() => expect(fetch.mock.calls[0]?.[0]).toBe(`/api/v1/projects/${projectId}/tasks/${id(1)}`));
    await act(async () => { pending.resolve(response(detail())); });
    expect(await screen.findByRole('heading', { name: '任务 1' })).toBeVisible();
    expect(screen.getByText('可开始')).toBeVisible();
    expect(screen.getByText('无前置依赖')).toBeVisible();
    expect(screen.getByText('所有前置已完成')).toBeVisible();
    expect(screen.getByText('无后续任务')).toBeVisible();
    expect(screen.getByRole('region', { name: '关联 PR' })).toHaveTextContent('关联 PR · 0');
    expect(screen.getByText('暂无关联 PR')).toBeVisible();
    expect(screen.queryByRole('button', { name: '刷新任务图' })).toBeNull();
    const times = dialog.querySelectorAll('time');
    expect(times).toHaveLength(2);
    expect(times[0]?.getAttribute('datetime')).toBe(timestamp);
    view.unmount();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('scroll');
    expect(trigger).toHaveFocus();
  });

  it('preserves ordered PR fields and duplicates as text, with explicit markers only for empty strings', async () => {
    const pullRequests = [
      { title: '  标题\n第二行\t\0', url: '  arbitrary\naddress\0  ' },
      { title: '<img src=x onerror=alert(1)>', url: '<script>window.leaked=true</script>' },
      { title: '', url: '' },
      { title: '  标题\n第二行\t\0', url: '  arbitrary\naddress\0  ' },
      { title: '很长的标题'.repeat(200), url: 'x'.repeat(5000) },
    ];
    const reviewed = detail(1, { properties: { pullRequests } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reviewed)));
    await open(props({ snapshot: snapshot([reviewed]) }));
    const region = await screen.findByRole('region', { name: '关联 PR' });
    expect(within(region).getByRole('heading')).toHaveTextContent('关联 PR · 5');
    const items = within(region).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.task-detail-pr-title')?.textContent))
      .toEqual(pullRequests.map(({ title }) => title === '' ? '（空字符串）' : title));
    expect(items.map((item) => item.querySelector('.task-detail-pr-value')?.textContent))
      .toEqual(pullRequests.map(({ url }) => url === '' ? '（空字符串）' : url));
    expect(region.querySelectorAll('.task-detail-pr-empty')).toHaveLength(2);
    expect(region.querySelectorAll('a,img,script')).toHaveLength(0);
    expect(items[0]?.querySelector('.task-detail-pr-title')?.textContent).toBe(items[3]?.querySelector('.task-detail-pr-title')?.textContent);
  });

  it('offers only browser-identifiable HTTP(S) links and includes them in the existing focus cycle', async () => {
    const pullRequests = [
      { title: '安全地址', url: 'https://github.com/example/repo/pull/1' },
      { title: '脚本地址', url: 'javascript:alert(1)' },
      { title: '数据地址', url: 'data:text/html,<script>alert(1)</script>' },
      { title: '相对地址', url: '/pull/2' },
      { title: '文件地址', url: 'file:///tmp/example' },
      { title: '损坏地址', url: 'http://[' },
      { title: '保留原值', url: '  HTTP://EXAMPLE.COM/pull/2  ' },
    ];
    const reviewed = detail(1, { properties: { pullRequests } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(reviewed)));
    await open(props({ snapshot: snapshot([reviewed]) }));
    const region = await screen.findByRole('region', { name: '关联 PR' });
    const links = within(region).getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([pullRequests[0]!.url, pullRequests[6]!.url]);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
    const close = screen.getByRole('button', { name: '关闭任务详情' });
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: '待处理' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '负责人：未分配' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('combobox', { name: '执行平台' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('switch', { name: '自动执行' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('tab', { name: '概览' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '编辑标签' })).toHaveFocus();
    await user.tab();
    expect(links[0]).toHaveFocus();
    await user.tab();
    expect(links[1]).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '复制任务 ID' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('heading', { name: '任务 1' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '复制任务标题' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '更多任务操作' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '更多任务操作' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '复制任务标题' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('heading', { name: '任务 1' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '复制任务 ID' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(links[1]).toHaveFocus();
  });

  it('waits for a matching summary before publishing a newer detail body', async () => {
    const old = detail();
    const fresh = detail(1, { version: 2n, properties: { pullRequests: [{ title: '新的关联', url: 'arbitrary' }] }, updatedAt: '2026-10-21T10:00:00Z' });
    const fetch = vi.fn().mockResolvedValueOnce(response(fresh));
    vi.stubGlobal('fetch', fetch);
    const initial = props({ snapshot: snapshot([old]) });
    const view = await open(initial);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByText('新的关联')).toBeNull();
    await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([fresh], 2)} />);
    await screen.findByText('新的关联');
    expect(screen.queryByRole('button', { name: '刷新任务图' })).toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('exposes malformed properties as a detail error without deriving an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stringifyApiJson({ ...detail(), properties: null }), { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) })));
    await open();
    await screen.findByRole('alert');
    expect(screen.queryByText('暂无关联 PR')).toBeNull();
    expect(screen.queryByRole('region', { name: '关联 PR' })).toBeNull();
  });

  it('escapes untrusted title and Markdown HTML and shows all snapshot relations as buttons', async () => {
    const title = '<img src=x onerror=alert(1)>'.repeat(10);
    const description = '<script>privateMarkup()</script>\nsecond line';
    const a = detail(1, { title: '前置任务' });
    const b = detail(2, { title, description, dependsOn: [a.id], blockedBy: [a.id], ready: false });
    const c = detail(3, { title: '后续任务', dependsOn: [b.id], blockedBy: [b.id], ready: false });
    const selected = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(b)));
    await open(props({ taskId: b.id, snapshot: snapshot([a, b, c]), onSelectTask: selected }));
    await screen.findByRole('heading', { name: title });
    expect(screen.getByRole('region', { name: '描述' }).querySelector('.task-description')?.textContent).toBe(description);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('被阻塞')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '前置依赖' })).getByRole('button', { name: /^前置任务，普通依赖$/ })).toBeVisible();
    expect(within(screen.getByRole('region', { name: '当前未完成的前置' })).getByRole('button', { name: /^前置任务，普通依赖$/ })).toBeVisible();
    const next = within(screen.getByRole('region', { name: '任务图快照中的直接后续' })).getByRole('button', { name: /^后续任务，普通依赖$/ });
    fireEvent.click(next);
    expect(selected).toHaveBeenCalledWith(c.id);
    expect(screen.getAllByText(b.id)).toHaveLength(1);
  });

  it('waits for a complete summary when navigation reaches a task outside the admitted graph', async () => {
    const prerequisite = detail(9);
    const unknown = detail(8, { dependsOn: [id(9)], blockedBy: [id(9)], ready: false, description: '' });
    const fetch = vi.fn().mockResolvedValue(response(unknown));
    vi.stubGlobal('fetch', fetch);
    const initial = props({ taskId: unknown.id });
    const view = await open(initial);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: unknown.title })).toBeNull();
    await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([detail(), unknown, prerequisite], 2)} />);
    await screen.findByRole('heading', { name: unknown.title });
    expect(screen.getByText('暂无描述')).toBeVisible();
    const references = screen.getAllByRole('button', { name: `${prerequisite.title}，普通依赖` });
    expect(references).toHaveLength(2);
    fireEvent.click(references[0]!);
    expect(initial.onSelectTask).toHaveBeenCalledWith(prerequisite.id);
  });

  it('preserves raw readiness mismatch and rematerializes matching content after dependency sync', async () => {
    const old = detail(2, { dependsOn: [id(1)], blockedBy: [id(1)], ready: false });
    const fresh = detail(2, { dependsOn: [id(1)], blockedBy: [], ready: true });
    const fetch = vi.fn().mockResolvedValueOnce(response(fresh));
    vi.stubGlobal('fetch', fetch);
    const first = props({ taskId: old.id, snapshot: snapshot([detail(), old]) });
    const view = await open(first);
    await screen.findByRole('button', { name: '刷新任务图' });
    expect(screen.getByText('被阻塞')).toBeVisible();
    expect(screen.getByRole('button', { name: '待处理' })).toBeDisabled();
    const refreshed = snapshot([detail(1, { status: 'done', ready: false, version: 2n }), fresh], 2);
    await view.rerender(<TaskDetailDialog {...first} snapshot={refreshed} />);
    expect(document.querySelector('.task-detail-retained')).toBeNull();
    expect(screen.getByRole('heading', { name: fresh.title })).toBeVisible();
    await screen.findByRole('heading', { name: fresh.title });
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.getByText('可开始')).toBeVisible();
    expect(screen.queryByRole('button', { name: '刷新任务图' })).toBeNull();
  });

  it.each([
    { locale: 'en', overview: 'Overview', statusLabel: 'To do' },
    { locale: 'zh-CN', overview: '概览', statusLabel: '待处理' },
  ] as const)('keeps unchanged summary receipts quiet and status selection available in $locale', async ({ locale, overview, statusLabel }) => {
    const reviewed = detail(1, { status: 'todo', ready: true });
    const fetch = vi.fn().mockResolvedValueOnce(response(reviewed));
    vi.stubGlobal('fetch', fetch);
    const initial = props({ snapshot: snapshot([reviewed]) });
    const view = await open(initial, locale);
    await screen.findByRole('heading', { name: reviewed.title });
    const heading = document.querySelector<HTMLElement>('.task-detail-heading')!;
    const panel = screen.getByRole('tabpanel', { name: overview });
    const statusButton = screen.getByRole('button', { name: statusLabel });
    panel.scrollTop = 140;
    statusButton.focus();

    for (const index of [0, 1, 2]) {
      await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([reviewed], index + 2)} />);
      expect(fetch).toHaveBeenCalledOnce();
      expect(within(heading).queryByRole('status')).toBeNull();
      expect(statusButton).toBeEnabled();
      expect(statusButton).toHaveFocus();
      expect(screen.getByRole('tabpanel', { name: overview })).toBe(panel);
      expect(panel.scrollTop).toBe(140);
    }
  });

  it('preserves the selected attachment panel, draft, focus and scroll through refresh errors and recovery', async () => {
    const update = deferred<Response>();
    const recovery = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(detail())).mockReturnValueOnce(update.promise).mockReturnValueOnce(recovery.promise);
    vi.stubGlobal('fetch', fetch);
    const fresh = detail(1, { description: '新的描述', version: 2n });
    const initial = props();
    const view = await open(initial);
    await screen.findByRole('heading', { name: '任务 1' });
    fireEvent.click(screen.getByRole('tab', { name: '附件' }));
    const panel = screen.getByRole('tabpanel', { name: '附件' });
    const attachment = screen.getByRole('region', { name: '附件' });
    const draft = screen.getByRole('textbox', { name: '附件草稿' });
    fireEvent.change(draft, { target: { value: 'notes/working.md' } });
    draft.focus();
    const body = document.querySelector('.task-detail-body')!;
    body.scrollTop = 140;
    await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([fresh], 2)} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('正在加载任务详情')).toBeNull();
    expect(screen.getByRole('tabpanel', { name: '附件' })).toBe(panel);
    expect(screen.getByRole('region', { name: '附件' })).toBe(attachment);
    expect(draft).toHaveFocus();
    await act(async () => { update.resolve(failure()); });
    expect(screen.getByRole('alert')).toHaveTextContent('任务详情更新失败');
    expect(screen.getByRole('alert')).toHaveTextContent('正在显示上次成功读取的详情，将自动重试更新。');
    const retained = screen.getByText('当前显示之前读取的任务详情，确认最新详情前无法修改任务。');
    expect(screen.getByRole('region', { name: '附件' })).toBe(attachment);
    expect(draft).toHaveValue('notes/working.md');
    expect(draft).toHaveFocus();
    await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([fresh], 3)} />);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByText('当前显示之前读取的任务详情，确认最新详情前无法修改任务。')).toBe(retained);
    await act(async () => { recovery.resolve(response(fresh)); });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(document.querySelector('.task-detail-retained')).toBeNull();
    expect(screen.getByRole('tabpanel', { name: '附件' })).toBe(panel);
    expect(screen.getByRole('region', { name: '附件' })).toBe(attachment);
    expect(draft).toHaveValue('notes/working.md');
    expect(draft).toHaveFocus();
    expect(body.scrollTop).toBe(140);
    fireEvent.click(screen.getByRole('tab', { name: '概览' }));
    expect(screen.getByText('新的描述')).toBeVisible();
  });

  it('retains the selected PR page when a receipt changes other detail fields', async () => {
    const pullRequests = Array.from({ length: 101 }, (_, index) => ({ title: `PR ${index}`, url: `https://example.com/pr/${index}` }));
    const original = detail(1, { properties: { pullRequests } });
    const update = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response(original)).mockReturnValueOnce(update.promise));
    const initial = props({ snapshot: snapshot([original]) });
    const view = await open(initial);
    const next = await screen.findByRole('button', { name: '下一页' });
    fireEvent.click(next);
    const page = screen.getByRole('combobox', { name: '关联 PR 页码' });
    page.focus();
    expect(page).toHaveValue('1');
    expect(screen.getByText('PR 100')).toBeVisible();
    const fresh = { ...original, description: '新的描述', version: original.version + 1n };
    await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([fresh], 2)} />);
    await act(async () => { update.resolve(response(fresh)); });
    expect(screen.getByRole('combobox', { name: '关联 PR 页码' })).toBe(page);
    expect(page).toHaveValue('1');
    expect(page).toHaveFocus();
    expect(screen.getByText('PR 100')).toBeVisible();
    expect(await screen.findByText('新的描述')).toBeVisible();
  });

  it('removes retained content and attachments when a refresh reports a missing task', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(detail())).mockResolvedValueOnce(failure('not_found'));
    vi.stubGlobal('fetch', fetch);
    const initial = props();
    const view = await open(initial);
    await screen.findByRole('heading', { name: '任务 1' });
    await view.rerender(<TaskDetailDialog {...initial} snapshot={snapshot([detail(1, { version: 2n })], 2)} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('heading', { name: '任务 1' })).toBeNull();
    expect(document.querySelector('[data-task-id]')).toBeNull();
    expect(screen.queryByText('正在显示上次成功读取的详情，将自动重试更新。')).toBeNull();
  });

  it('clears the previous identity immediately, cancels old reads, and ignores late results', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(response(detail())).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetch);
    const originalRestore = vi.fn();
    const latestRestore = vi.fn(() => trigger.focus());
    const initial = props({ onRestoreFocus: originalRestore, snapshot: snapshot([detail(), detail(2), detail(3)]) });
    const view = await open(initial);
    await screen.findByRole('heading', { name: '任务 1' });
    await view.rerender(<TaskDetailDialog {...initial} taskId={id(2)} />);
    expect(screen.queryByRole('heading', { name: '任务 1' })).toBeNull();
    expect(screen.getByRole('status')).toHaveAccessibleName('正在加载任务详情');
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const firstSignal = fetch.mock.calls[1]?.[1].signal as AbortSignal;
    await view.rerender(<TaskDetailDialog {...initial} taskId={id(3)} onRestoreFocus={latestRestore} />);
    expect(firstSignal.aborted).toBe(true);
    await act(async () => { second.resolve(response(detail(3))); });
    await screen.findByRole('heading', { name: '任务 3' });
    await act(async () => { first.resolve(response(detail(2))); });
    expect(screen.queryByRole('heading', { name: '任务 2' })).toBeNull();
    expect(originalRestore).not.toHaveBeenCalled();
    expect(latestRestore).not.toHaveBeenCalled();
    expect(root.hasAttribute('inert')).toBe(true);
    view.unmount();
    expect(originalRestore).not.toHaveBeenCalled();
    expect(latestRestore).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it('keeps failures local, hides private errors, and retries with fresh detail', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(failure()).mockRejectedValueOnce(new Error('private token'))
      .mockResolvedValueOnce(new Response('{}', { headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) }))
      .mockResolvedValueOnce(response(detail()));
    vi.stubGlobal('fetch', fetch);
    await open();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAccessibleName('任务详情加载失败');
    expect(alert).toHaveTextContent('task-detail-request-123');
    expect(alert).not.toHaveTextContent('private database password');
    fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
    await screen.findByText('无法连接服务，请检查本地服务后重试。');
    expect(document.body).not.toHaveTextContent('private token');
    expect(screen.queryByText('task-detail-request-123')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
    await screen.findByRole('alert');
    expect(screen.getByText('暂时无法读取任务详情，请重试。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试详情' }));
    await screen.findByRole('heading', { name: '任务 1' });
    expect(screen.getByRole('button', { name: '待处理' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('shows a useful not-found message without inventing task content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failure('not_found')));
    await open();
    await screen.findByRole('alert');
    expect(screen.getByText('这个任务已无法读取，请刷新任务图。')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '任务 1' })).toBeNull();
  });

  it('traps both Tab directions as loading and retry controls change, and handles Escape and backdrop close', async () => {
    const loading = deferred<Response>();
    const retry = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(loading.promise).mockReturnValueOnce(retry.promise);
    const onClose = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const options = props({ onClose });
    await open(options);
    const close = screen.getByRole('button', { name: '关闭任务详情' });
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await act(async () => { loading.resolve(failure()); });
    const retryButton = await screen.findByRole('button', { name: '重试详情' });
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '更多任务操作' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(retryButton).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '更多任务操作' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab();
    expect(retryButton).toHaveFocus();
    await user.click(retryButton);
    expect(close).toHaveFocus();
    trigger.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: '进入全屏' })).toHaveFocus();
    await act(async () => { retry.resolve(response(detail())); });
    await screen.findByRole('heading', { name: '任务 1' });
    fireEvent.click(screen.getByRole('heading', { name: '任务 1' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('supports native keyboard relation selection without restoring the canvas trigger on navigation', async () => {
    const first = detail();
    const second = detail(2, { dependsOn: [first.id], blockedBy: [first.id], ready: false });
    const fetch = vi.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second));
    const selected = vi.fn();
    const restored = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const options = props({ snapshot: snapshot([first, second]), onSelectTask: selected, onRestoreFocus: restored });
    const view = await open(options);
    const successor = await screen.findByRole('button', { name: /^任务 2，普通依赖$/ });
    fireEvent.click(screen.getByRole('button', { name: '进入全屏' }));
    const shell = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: '关闭任务详情' });
    const user = userEvent.setup();
    successor.focus();
    await user.keyboard('{Enter}');
    expect(selected).toHaveBeenCalledWith(second.id);
    await view.rerender(<TaskDetailDialog {...options} taskId={second.id} />);
    expect(screen.getByRole('dialog')).toBe(shell);
    expect(screen.getByRole('button', { name: '关闭任务详情' })).toBe(close);
    expect(document.body.style.overflow).toBe('hidden');
    expect(root).toHaveAttribute('inert');
    expect(restored).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '关闭任务详情' })).toHaveFocus();
    await screen.findByRole('heading', { name: '任务 2' });
    expect(shell).toHaveClass('task-detail-fullscreen');
    const predecessor = screen.getAllByRole('button', { name: /^任务 1，普通依赖$/ })[0]!;
    predecessor.focus();
    await user.keyboard(' ');
    expect(selected).toHaveBeenLastCalledWith(first.id);
    expect(restored).not.toHaveBeenCalled();
  });

  it('removes the portal, inert state, scroll lock, and keyboard listener before restoring focus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>(() => {})));
    document.body.style.overflow = 'auto';
    const onClose = vi.fn();
    const onRestoreFocus = vi.fn(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(root).not.toHaveAttribute('inert');
      expect(document.body.style.overflow).toBe('auto');
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });
    const view = await open(props({ onClose, onRestoreFocus }));
    view.unmount();
    expect(onRestoreFocus).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it('keeps graph refresh and truncated relation controls in the current focus cycle', async () => {
    const prerequisite = detail(3, { status: 'done', ready: false });
    const first = detail(1, { status: 'done', ready: false, dependsOn: [prerequisite.id] });
    const second = detail(2, { title: '很长的后续任务标题'.repeat(30), dependsOn: [first.id], blockedBy: [], ready: true });
    const latest = { ...first, blockedBy: [prerequisite.id] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(latest)));
    await open(props({ snapshot: snapshot([first, second, prerequisite]) }));
    const refresh = await screen.findByRole('button', { name: '刷新任务图' });
    const dialog = screen.getByRole('dialog');
    const successor = screen.getByRole('button', { name: `${Array.from(second.title).slice(0, 160).join('')}…，普通依赖` });
    expect(screen.getByRole('button', { name: '已完成' })).toBeDisabled();
    const controls = dialogFocusables(dialog);
    expect(controls).toContain(refresh);
    expect(controls).toContain(successor);
    const user = userEvent.setup();
    controls[0]!.focus();
    for (let index = 1; index <= controls.length; index++) {
      await user.tab();
      expect(controls[index % controls.length]).toHaveFocus();
    }
    for (let index = controls.length - 1; index >= 0; index--) {
      await user.tab({ shift: true });
      expect(controls[index]).toHaveFocus();
    }
  });

  it('cancels in-flight details on close and preserves pre-existing inert state', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetch);
    root.setAttribute('inert', '');
    const view = await open();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const signal = fetch.mock.calls[0]?.[1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(root.hasAttribute('inert')).toBe(true);
    await act(async () => { pending.reject(new Error('late failure')); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
