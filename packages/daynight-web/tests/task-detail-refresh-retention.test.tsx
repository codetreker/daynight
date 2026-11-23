import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRef, type RefObject } from 'react';
import { assertResponsePrincipal, cancelAuthNetworkRequests, getTask, pauseAuthRequests, request } from '../src/api/client';
import type { Attachment } from '../src/api/types';
import { TaskDetailSessionProvider, useTaskDetailSessions, type TaskDetailSessions } from '../src/features/task-detail/TaskDetailSession';
import { TaskDraftBoundary } from '../src/features/task-detail/TaskDraftNavigation';
import { useTaskDetail } from '../src/features/task-detail/useTaskDetail';
import { TaskAttachments } from '../src/features/task-detail/attachments/TaskAttachments';
import type { AttachmentApi } from '../src/features/task-detail/attachments/useAttachments';
import type { ThreadController } from '../src/features/task-thread/controller';
import { TaskDiscussion } from '../src/features/task-thread/TaskDiscussion';
import type { ThreadMessage } from '../src/features/task-thread/contract';
import { renderWithLocale } from './helpers/renderWithLocale';
import { detailFixture, resourceResponse } from './helpers/taskDetail';
import { createTaskSessionWorld } from './helpers/taskSessions';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const observedThread = vi.hoisted(() => ({ current: null as ThreadController | null }));
vi.mock('../src/features/task-thread/controller', async (original) => {
  const actual = await original<typeof import('../src/features/task-thread/controller')>();
  return { ...actual, createThreadController: (...args: Parameters<typeof actual.createThreadController>) => {
    const controller = actual.createThreadController(...args); observedThread.current = controller; return controller;
  } };
});

const project = '10000000-0000-4000-8000-000000000001';
const task = '20000000-0000-4000-8000-000000000001';
const otherTask = '20000000-0000-4000-8000-000000000002';
const otherUser = '99999999-9999-4999-8999-999999999999';
const initial = detailFixture(project, task, { title: 'Alice task', description: 'Alice description', version: 5n });
const message: ThreadMessage = { id: '30000000-0000-4000-8000-000000000001', author: { userId: TEST_VIEWER_ID, displayName: 'Alice', Agent: false }, body: 'Alice message', createdAt: '2026-11-03T08:01:00.123Z' };
const receipt: ThreadMessage = { ...message, id: '30000000-0000-4000-8000-000000000002', body: 'Submitted', createdAt: '2026-11-03T08:02:00.123Z' };
const file: Attachment = { path: 'one.txt', contentType: 'text/plain', sizeBytes: 12, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const threadResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
const untilAborted = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  void promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
});

it('publishes an already confirmed discussion after a temporary pause without clearing newer edits', async () => {
  const world = createTaskSessionWorld();
  const gate = deferred<void>(); const entered = deferred<void>(); const post = deferred<Response>();
  let updated = false;
  const fetcher = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/thread/messages')) return init?.method === 'POST' ? untilAborted(post.promise, init.signal!) : Promise.resolve(threadResponse({ items: [message], hasMoreBefore: false, hasMoreAfter: false }));
    return Promise.resolve(resourceResponse(updated ? { ...initial, version: 6n } : initial, TEST_VIEWER_ID));
  });
  vi.stubGlobal('fetch', fetcher);
  let resume: (() => void) | undefined;
  let view: ReturnType<typeof renderWithLocale> | undefined;
  try {
    await world.sync([initial]); let node = world.node(project, task);
    const Workspace = () => {
      const owner = useRef<HTMLDivElement>(null);
      useTaskDetail(project, task, 1, node);
      return <TaskDraftBoundary projectId={project} taskId={task} page>
        <div ref={owner}><TaskDiscussion projectId={project} taskId={task} active owner={owner as RefObject<HTMLElement | null>} onDetailsOpenChange={() => {}} /></div>
      </TaskDraftBoundary>;
    };
    const tree = () => <TaskDetailSessionProvider><Workspace /></TaskDetailSessionProvider>;
    view = renderWithLocale(tree(), { locale: 'zh-CN', taskCache: { scope: world.scope } });
    const thread = observedThread.current!;
    await screen.findByText('Alice message');
    fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: 'Submitted' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '消息详情' }));
    const dialog = screen.getByRole('dialog', { name: '消息详情' });
    const ready = world.scope.ready.bind(world.scope);
    vi.spyOn(world.scope, 'ready').mockImplementation(async signal => {
      if (thread.snapshot().remoteOutcome === 'confirmed') { entered.resolve(); await untilAborted(gate.promise, signal); }
      return ready(signal);
    });
    await act(async () => { post.resolve(threadResponse(receipt, 201)); await entered.promise; });
    expect(thread.snapshot()).toMatchObject({ remoteOutcome: 'confirmed', sending: false, visible: [message] });
    act(() => { resume = pauseAuthRequests(); cancelAuthNetworkRequests(); });
    fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: 'New draft' } });
    gate.resolve(); await act(async () => { await Promise.resolve(); });
    expect(thread.snapshot()).toMatchObject({ draft: 'New draft', visible: [message], detailsMessage: message });
    act(() => { resume!(); }); resume = undefined;
    updated = true;
    await act(async () => { await world.sync([{ ...initial, version: 6n }]); node = world.node(project, task); view!.rerender(tree()); });
    await waitFor(() => expect(thread.snapshot().visible).toEqual([message, receipt]));
    expect(thread.snapshot()).toMatchObject({ draft: 'New draft', detailsMessage: message, sending: false });
    expect(screen.getByRole('textbox', { name: '讨论消息' })).toHaveValue('New draft');
    expect(screen.getByRole('dialog', { name: '消息详情' })).toBe(dialog);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  } finally { view?.unmount(); world.dispose(); gate.resolve(); post.resolve(threadResponse(receipt, 201)); resume?.(); }
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('releases confirmed publication when the discussion owner unmounts without opening its gate', async () => {
  const world = createTaskSessionWorld();
  const gate = deferred<void>(); const entered = deferred<void>(); const settled = deferred<void>(); const post = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (!url.includes('/thread/messages')) throw new Error(`Unexpected request: ${url}`);
    return init?.method === 'POST' ? untilAborted(post.promise, init.signal!) : Promise.resolve(threadResponse({ items: [message], hasMoreBefore: false, hasMoreAfter: false }));
  }));
  let view: ReturnType<typeof renderWithLocale> | undefined; let publicationSignal: AbortSignal | undefined;
  try {
    const Workspace = () => { const owner = useRef<HTMLDivElement>(null); return <div ref={owner}><TaskDiscussion projectId={project} taskId={task} active owner={owner as RefObject<HTMLElement | null>} onDetailsOpenChange={() => {}} /></div>; };
    view = renderWithLocale(<Workspace />, { locale: 'zh-CN', taskCache: { scope: world.scope } });
    const thread = observedThread.current!;
    await screen.findByText('Alice message');
    fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: 'Submitted' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(thread.snapshot().remoteOutcome).toBe('dispatched'));
    const ready = world.scope.ready.bind(world.scope);
    vi.spyOn(world.scope, 'ready').mockImplementation(async signal => {
      if (thread.snapshot().remoteOutcome === 'confirmed') {
        publicationSignal = signal; entered.resolve();
        try { await untilAborted(gate.promise, signal); } finally { settled.resolve(); }
      }
      return ready(signal);
    });
    await act(async () => { post.resolve(threadResponse(receipt, 201)); await entered.promise; });
    expect(thread.snapshot()).toMatchObject({ remoteOutcome: 'confirmed', sending: false, visible: [message] });
    view.unmount(); view = undefined;
    await settled.promise;
    expect(publicationSignal?.aborted).toBe(true); expect(thread.snapshot().retired).toBe(true);
  } finally { view?.unmount(); world.dispose(); gate.resolve(); post.resolve(threadResponse(receipt, 201)); }
});

it.each(['preparing', 'dispatched', 'confirmed'] as const)('retains the shared Task detail during identity mismatch with %s operations', async (stage) => {
  let resume: (() => void) | undefined;
  const mismatch = vi.fn(() => {
    expect(world.scope.signal.aborted).toBe(false); expect(world.scope.isInvalidated).toBe(false);
    resume = pauseAuthRequests(); cancelAuthNetworkRequests();
  });
  const world = createTaskSessionWorld({ onIdentityMismatch: mismatch });
  let session!: TaskDetailSessions;
  let thread!: ThreadController;
  const gate = deferred<void>(); const entered = deferred<void>(); const post = deferred<Response>();
  const mismatchResponse = resourceResponse(detailFixture(project, otherTask, { title: 'Bob secret' }), otherUser);
  const readBobBody = vi.spyOn(mismatchResponse, 'text');
  const fetcher = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
    if (url === '/ordinary-probe') return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    if (url.endsWith(`/tasks/${otherTask}`)) return Promise.resolve(mismatchResponse);
    if (url.includes('/thread/messages')) return init?.method === 'POST' ? untilAborted(post.promise, init.signal!) : Promise.resolve(threadResponse({ items: [message], hasMoreBefore: false, hasMoreAfter: false }));
    return Promise.resolve(resourceResponse(initial, TEST_VIEWER_ID));
  });
  vi.stubGlobal('fetch', fetcher);
  const attachmentApi: AttachmentApi = {
    list: vi.fn(async () => ({ items: [file], nextCursor: null })),
    readText: vi.fn(async () => 'Alice attachment preview'),
    put: vi.fn(async () => file), remove: vi.fn(async () => {}),
  };
  const caller = new AbortController();
  let view: ReturnType<typeof renderWithLocale> | undefined;
  try {
    await world.sync([initial]);
    const node = world.node(project, task);
    const Workspace = () => {
      const owner = useRef<HTMLDivElement>(null);
      session = useTaskDetailSessions();
      useTaskDetail(project, task, 1, node);
      return <TaskDraftBoundary projectId={project} taskId={task} page>
        <TaskAttachments projectId={project} taskId={task} api={attachmentApi} />
        <div ref={owner}><TaskDiscussion projectId={project} taskId={task} active owner={owner as RefObject<HTMLElement | null>} onDetailsOpenChange={() => {}} /></div>
      </TaskDraftBoundary>;
    };
    view = renderWithLocale(<TaskDetailSessionProvider><Workspace /></TaskDetailSessionProvider>, { locale: 'zh-CN', taskCache: { scope: world.scope } });
    thread = observedThread.current!;
    fireEvent.click(await screen.findByRole('button', { name: /^one\.txt/ }));
    await screen.findByText('Alice attachment preview');
    await waitFor(() => { expect(session.snapshot(project, task).detail).toEqual(initial); expect(thread.snapshot().visible).toEqual([message]); });
    await screen.findByText('Alice message');
    fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: 'Submitted' } });
    const location = window.location.href;
    fireEvent.click(screen.getByText('上传文件', { selector: 'summary' }));
    fireEvent.change(screen.getByLabelText('选择一个文件'), { target: { files: [new File(['draft'], 'draft.txt', { type: 'text/plain' })] } });
    fireEvent.change(screen.getByLabelText('目标相对路径'), { target: { value: 'Alice draft' } });

    if (stage === 'preparing') {
      const ready = world.scope.ready.bind(world.scope); let held = false;
      vi.spyOn(world.scope, 'ready').mockImplementation(async signal => {
        if (!held) { held = true; entered.resolve(); await untilAborted(gate.promise, signal); }
        return ready(signal);
      });
    }
    const send = vi.spyOn(thread, 'send');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(send).toHaveBeenCalledOnce(); const sent = send.mock.results[0]!.value;
    if (stage === 'preparing') { await entered.promise; await waitFor(() => expect(thread.snapshot()).toMatchObject({ sending: true, postOutcome: 'waiting_auth' })); }
    else await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '消息详情' }));
    const dialog = screen.getByRole('dialog', { name: '消息详情' });
    const probe = request('/ordinary-probe', caller.signal).catch(error => error);
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === '/ordinary-probe')).toBe(true));
    const probeSignal = fetcher.mock.calls.find(([url]) => url === '/ordinary-probe')![1]!.signal!;
    const count = fetcher.mock.calls.length;
    if (stage === 'confirmed') {
      let interrupted = false;
      const unsubscribe = thread.subscribe(() => {
        if (interrupted || thread.snapshot().remoteOutcome !== 'confirmed') return;
        interrupted = true;
        expect(thread.snapshot().sending).toBe(true);
        expect(() => assertResponsePrincipal(mismatchResponse, TEST_VIEWER_ID, world.scope.principalMismatch)).toThrow();
      });
      await act(async () => { post.resolve(threadResponse(receipt, 201)); await sent; });
      unsubscribe(); expect(interrupted).toBe(true);
    } else await act(async () => {
      await expect(getTask(project, otherTask, new AbortController().signal, { userId: TEST_VIEWER_ID, onPrincipalMismatch: world.scope.principalMismatch })).rejects.toMatchObject({ code: 'principal_mismatch' });
    });
    expect(mismatch).toHaveBeenCalledOnce(); expect(readBobBody).not.toHaveBeenCalled();
    expect(world.scope.signal.aborted).toBe(false); expect(world.scope.isInvalidated).toBe(false);
    expect(caller.signal.aborted).toBe(false); expect(probeSignal.aborted).toBe(true); await probe;
    await sent;
    await waitFor(() => expect(thread.snapshot().sending).toBe(false));
    expect(thread.snapshot()).toMatchObject({ visible: [message], draft: 'Submitted', detailsMessage: message, sending: false, postOutcome: stage === 'preparing' ? 'refused' : stage === 'dispatched' ? 'unknown' : 'confirmed', remoteOutcome: stage === 'preparing' ? 'not_sent' : stage === 'dispatched' ? 'unknown' : 'confirmed' });
    expect(session.snapshot(project, task).detail).toEqual(initial);
    expect(screen.getByRole('textbox', { name: '讨论消息' })).toHaveValue('Submitted');
    expect(screen.getByRole('dialog', { name: '消息详情' })).toBe(dialog); expect(window.location.href).toBe(location);
    expect(screen.getByText('Alice attachment preview')).toBeVisible(); expect(screen.getByRole('button', { name: /^one\.txt/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('目标相对路径')).toHaveValue('Alice draft');
    expect(screen.getByText('下载', { selector: 'a' })).not.toHaveAttribute('href');
    expect(screen.getByText('下载', { selector: 'a' })).not.toHaveAttribute('download');
    expect(screen.getByLabelText('在新标签页打开')).not.toHaveAttribute('href');
    fireEvent.submit(screen.getByLabelText('目标相对路径').closest('form')!);
    expect(attachmentApi.put).not.toHaveBeenCalled(); expect(attachmentApi.remove).not.toHaveBeenCalled();
    expect(attachmentApi.list).toHaveBeenCalledOnce(); expect(attachmentApi.readText).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(count + (stage === 'confirmed' ? 0 : 1));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(stage === 'preparing' ? 0 : 1);
    fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: 'New discussion draft' } });
    if (stage !== 'confirmed') gate.resolve();
    post.resolve(threadResponse(receipt, 201));
    await act(async () => { await Promise.resolve(); });
    expect(thread.snapshot().draft).toBe('New discussion draft'); expect(thread.snapshot().visible).toEqual([message]);
    expect(screen.getByRole('textbox', { name: '讨论消息' })).toHaveValue('New discussion draft');
    expect(screen.getByRole('dialog', { name: '消息详情' })).toBe(dialog); expect(window.location.href).toBe(location);
    expect(fetcher).toHaveBeenCalledTimes(count + (stage === 'confirmed' ? 0 : 1));
  } finally {
    view?.unmount(); thread?.retire(); world.dispose(); gate.resolve(); post.resolve(threadResponse(receipt, 201)); resume?.();
  }
});
