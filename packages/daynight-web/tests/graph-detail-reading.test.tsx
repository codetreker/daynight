import { selectTaskList } from './helpers/projectViews';
import { directAccessFixture, taskSyncReadFixture, TEST_VIEWER_ID, taskSyncFromGraph } from "./helpers/taskSync";
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTaskStatus, attachmentPreviewRoot, getTask, getTaskSync, listAttachments, readAttachmentText } from '../src/api/client';
import { getProject } from '../src/api/project-settings';
import { getProjectAccess } from '../src/api/auth';
import type { Attachment, TaskDetail, TaskGraph } from '../src/api/types';
import { ProjectPage } from '../src/features/projects/ProjectPage';
import { TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { createLocaleRender } from './helpers/renderWithLocale';
import { installGraphMeasurements } from './graph-measurements';
import { completeContextGraph } from './helpers/graphData';

vi.mock('../src/api/client', async (original) => { const actual = await original<typeof import('../src/api/client')>(); const { fixtureTaskEpoch } = await import('./helpers/taskSync'); const read = vi.fn(); return { ...actual,
  setTaskStatus: vi.fn(), getTaskSync: vi.fn(), getTask: read, getTaskObservation: async (...args: Parameters<typeof actual.getTask>) => ({ detail: await read(...(args[4] === undefined ? args.slice(0, 4) : args)), epoch: fixtureTaskEpoch(args[0]) }), listAttachments: vi.fn(), readAttachmentText: vi.fn(), }; });
vi.mock('../src/api/project-settings', async original => ({ ...await original<typeof import('../src/api/project-settings')>(), getProject: vi.fn() }));
vi.mock('../src/api/auth', async original => ({ ...await original<typeof import('../src/api/auth')>(), getProjectAccess: vi.fn() }));

const graphRequest = vi.fn<(projectId: string, signal: AbortSignal) => Promise<TaskGraph>>();

const localeRender = createLocaleRender('zh-CN');
const render: typeof localeRender = (ui, options) => localeRender(ui, { ...options, taskCache: true });
const graph = completeContextGraph;
const rootId = graph.tasks.find((task) => task.titlePreview === '外部上下文 · 链内交付起点')!.id;
const selectedId = graph.tasks.find((task) => task.titlePreview === '外部前置 · 菱形合流')!.id;
const detailNode = graph.tasks.find((task) => task.titlePreview === '链内最终交付')!;
const detail: TaskDetail = {
  ...detailNode, tags: [], version: 2n, projectId: graph.project.id, title: detailNode.titlePreview,
  description: '# Delivery notes\n\n[Read acceptance guide](docs/guide.md)', properties: { pullRequests: [] },
};
const attachment: Attachment = {
  path: 'docs/guide.md', contentType: 'text/markdown', sizeBytes: 64,
  createdAt: detailNode.createdAt, updatedAt: detailNode.updatedAt,
};
let root: HTMLDivElement;
let cancelDetailWait: (() => void) | undefined;

beforeEach(() => {
  window.history.replaceState(null, "", `/projects/${graph.project.id}`);
  vi.mocked(getTaskSync).mockReset().mockImplementation(async (projectId, query, _userId, signal) => taskSyncReadFixture(taskSyncFromGraph(await graphRequest(projectId, signal), { query, versionForTask: (task) => task.id === detail.id ? detail.version : 1n, propertiesForTask: (task) => task.id === detail.id ? detail.properties : {} })));
});

beforeEach(() => {
  installGraphMeasurements();
  vi.mocked(getProject).mockReset().mockResolvedValue(graph.project);
  vi.mocked(getProjectAccess).mockReset().mockImplementation(async (id, _signal, admission) => directAccessFixture(id, admission.userId));
  vi.mocked(setTaskStatus).mockReset();
  root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  graphRequest.mockReset().mockResolvedValue(graph);
  vi.mocked(getTask).mockReset().mockResolvedValue(detail);
  vi.mocked(listAttachments).mockReset().mockResolvedValue({ items: [attachment], nextCursor: null });
  vi.mocked(readAttachmentText).mockReset().mockResolvedValue('# Attachment acceptance\n\n![Diagram](../images/diagram.svg)\n\nAll checks passed.');
});
afterEach(() => { cancelDetailWait?.(); cancelDetailWait = undefined; cleanup(); root.remove(); });

const graphSnapshot = (container: HTMLElement) => ({
  hiddenUpstream: container.querySelector<HTMLElement>('.task-graph')!.dataset.hiddenUpstreamCount,
  nodes: [...container.querySelectorAll<HTMLElement>('.react-flow__node')].map((node) => ({
    id: node.dataset.id, position: node.style.transform, width: node.style.width, height: node.style.height,
    inspection: node.querySelector<HTMLElement>('.task-node')!.dataset.inspection,
  })),
  edges: [...container.querySelectorAll<SVGElement>('.task-dependency-edge')].map((edge) => ({
    id: edge.dataset.id, inspection: edge.dataset.inspection,
    shapes: [...edge.querySelectorAll<SVGElement>('.react-flow__edge-path,.task-dependency-paint-piece')].map((shape) => ({
      kind: shape.tagName, geometry: ['d', 'transform', 'x1', 'y1', 'x2', 'y2', 'marker-end'].map((name) => shape.getAttribute(name)),
      dashOffset: shape.style.strokeDashoffset,
    })),
  })),
  viewport: container.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform,
});

describe('graph inspection and detail reading integration', () => {
  it.each([false, true])('retains the selected dependency path while task permission %s opens Markdown and its attachment in the same dialog', async (allowAgents) => {
    graphRequest.mockResolvedValue({ ...graph, tasks: graph.tasks.map((task) => task.id === detailNode.id ? { ...task, allowAgents } : task) });
    const reads: Promise<void>[] = [];
    const sessions = TaskDetailSessions.prototype as unknown as { read(projectId: string, taskId: string, revision: number, reconciliation: boolean, retainLoaded: boolean, automatic?: boolean): Promise<void> };
    const read = sessions.read;
    vi.spyOn(sessions, 'read').mockImplementation(function (this: TaskDetailSessions, ...args) {
      const completion = read.call(this, ...args);
      if (args[0] === graph.project.id && args[1] === detail.id) reads.push(completion);
      return completion;
    });
    const detailRequested = Promise.withResolvers<Parameters<typeof getTask>>();
    const detailResponse = Promise.withResolvers<TaskDetail>();
    vi.mocked(getTask).mockImplementationOnce((...args) => { detailRequested.resolve(args); return detailResponse.promise; });
    const user = userEvent.setup();
    render(<ProjectPage projectId={graph.project.id} />, { container: root });
    await selectTaskList();
    await user.click(await screen.findByRole('button', { name: '外部上下文 · 链内交付起点，查看依赖关系' }));
    await waitFor(() => { expect(document.body.querySelectorAll('.react-flow__node')).toHaveLength(3); });
    await waitFor(() => { expect(document.body.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform).not.toBe('translate(0px,0px) scale(1)'); });
    const selected = document.body.querySelector<HTMLButtonElement>(`.react-flow__node[data-id="${selectedId}"] .task-node-body`)!;
    await user.click(selected);
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    const state = graphSnapshot(document.body);
    expect(state.hiddenUpstream).toBe('3');
    expect(state.nodes.filter((node) => node.inspection === 'selected').map((node) => node.id)).toEqual([selectedId]);
    expect(state.nodes.filter((node) => node.inspection === 'prerequisite').map((node) => node.id)).toEqual([]);
    expect(state.nodes.filter((node) => node.inspection === 'unrelated').map((node) => node.id)).toEqual([rootId]);
    expect(state.nodes.filter((node) => node.inspection === 'successor').map((node) => node.id)).toEqual([detailNode.id]);
    expect(state.edges.filter((edge) => edge.inspection === 'highlighted')).toHaveLength(0);
    expect(state.edges.filter((edge) => edge.inspection === 'successor')).toHaveLength(1);
    const trigger = within(document.body.querySelector<HTMLElement>(`.react-flow__node[data-id="${detailNode.id}"]`)!).getByRole('button', { name: `${detail.title}，详情` });
    await user.click(trigger);
    expect(await detailRequested.promise).toEqual([graph.project.id, detailNode.id, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function) }]);
    const loadingDialog = document.body.querySelector<HTMLElement>('.task-detail-dialog')!;
    expect(within(loadingDialog).getByRole('status')).toBeVisible();
    expect(within(loadingDialog).queryByRole('heading', { name: 'Delivery notes' })).toBeNull();
    expect(graphSnapshot(document.body)).toEqual(state);
    expect(reads).toHaveLength(1);
    const stopped = Promise.withResolvers<void>();
    cancelDetailWait = stopped.resolve;
    let completed = false;
    // Resolving the API response does not complete cache admission. Teardown
    // also releases act if the test times out while the read is still pending.
    await act(async () => {
      detailResponse.resolve({ ...detail, allowAgents });
      await Promise.race([reads[0]!.then(() => { completed = true; }), stopped.promise]);
    });
    if (!completed) return;
    const dialog = await screen.findByRole('dialog', { name: detail.title }).catch((error: unknown) => {
      const actual = document.body.querySelector<HTMLElement>('.task-detail-dialog');
      const status = actual?.querySelector<HTMLElement>('[role="status"]');
      const alert = actual?.querySelector<HTMLElement>('[role="alert"]');
      throw new Error(`Detail dialog after read: title=${JSON.stringify(actual?.querySelector('.task-detail-title')?.textContent ?? null)}, status=${JSON.stringify(status?.getAttribute('aria-label') ?? status?.textContent ?? null)}, alert=${JSON.stringify(alert?.textContent ?? null)}`, { cause: error });
    });
    await within(dialog).findByRole('heading', { name: 'Delivery notes' });
    expect(root).toHaveAttribute('inert');
    expect(within(dialog).getByRole('button', { name: '待处理' })).toBeEnabled();
    expect(graphSnapshot(document.body)).toEqual(state);
    const link = within(dialog).getByRole('link', { name: 'Read acceptance guide' });
    expect(link).toHaveAttribute('href', `${attachmentPreviewRoot(graph.project.id, detailNode.id)}docs/guide.md`);
    await user.click(link);
    expect(screen.getByRole('dialog', { name: detail.title })).toBe(dialog);
    expect(within(dialog).getByRole('tab', { name: '附件' })).toHaveAttribute('aria-selected', 'true');
    const preview = within(dialog).getByRole('group', { name: '附件预览' });
    expect(preview).toHaveFocus();
    await within(preview).findByRole('heading', { name: 'Attachment acceptance' });
    expect(within(preview).getByRole('img', { name: 'Diagram' })).toHaveAttribute('src', `${attachmentPreviewRoot(graph.project.id, detailNode.id)}images/diagram.svg`);
    expect(listAttachments).toHaveBeenCalledExactlyOnceWith(graph.project.id, detailNode.id, { limit: 100 }, expect.any(AbortSignal));
    expect(readAttachmentText).toHaveBeenCalledExactlyOnceWith(graph.project.id, detailNode.id, attachment.path, expect.any(AbortSignal));
    expect(graphSnapshot(document.body)).toEqual(state);
    await user.click(within(dialog).getByRole('button', { name: '关闭任务详情' }));
    expect(screen.queryByRole('dialog', { name: detail.title })).toBeNull();
    expect(document.body.querySelector('.task-chain-dialog')).not.toBeNull();
    expect(root).toHaveAttribute('inert');
    expect(trigger).toHaveFocus();
    expect(graphSnapshot(document.body)).toEqual(state);
    expect(setTaskStatus).not.toHaveBeenCalled();
    expect(graphRequest).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledExactlyOnceWith(graph.project.id, detailNode.id, expect.any(AbortSignal), { userId: TEST_VIEWER_ID, onPrincipalMismatch: expect.any(Function) });
    expect(reads).toHaveLength(1);
  });
});
// Dependency-path and attachment continuity do not own ordinary-parent reads.
vi.mock('../src/features/task-detail/OrdinaryTaskRelations', () => ({ OrdinaryTaskRelations: ({ render }: Pick<import('../src/features/task-detail/OrdinaryTaskRelations').OrdinaryTaskRelationsProps, 'render'>) => render?.({ parent: null, children: null }) ?? null }));
