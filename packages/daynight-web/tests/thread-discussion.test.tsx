import { useRef, type RefObject } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurrentAccountProvider } from '../src/app/CurrentAccountContext';
import { parseRoute, taskDetailUrl } from '../src/app/router';
import type { ThreadMessage } from '../src/features/task-thread/contract';
import { TaskDiscussion } from '../src/features/task-thread/TaskDiscussion';
import { renderWithLocale } from './helpers/renderWithLocale';
import { TEST_VIEWER_ID, viewerHeaders } from './helpers/taskSync';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const projectId = id(100), taskId = id(200);
const message = (value: number, body: string, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({ id: id(value), author: { userId: TEST_VIEWER_ID, displayName: 'Alice', Agent: false }, body, createdAt: `2026-11-03T08:${String(value).padStart(2, '0')}:00.123Z`, ...extra });
const resource = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: viewerHeaders(TEST_VIEWER_ID, { 'Content-Type': 'application/json' }) });
const page = (items: readonly ThreadMessage[], hasMoreBefore = false, hasMoreAfter = false) => resource({ items, hasMoreBefore, hasMoreAfter });
const Harness = ({ active = true, occupied = () => {}, admissionBlocked = false, parentUnavailable = false }: { readonly active?: boolean; readonly occupied?: (value: boolean) => void; readonly admissionBlocked?: boolean; readonly parentUnavailable?: boolean }) => {
  const owner = useRef<HTMLDivElement>(null);
  return <CurrentAccountProvider user={{ id: TEST_VIEWER_ID, name: 'Current Alice' }} admissionBlocked={admissionBlocked}><div ref={owner}><TaskDiscussion projectId={projectId} taskId={taskId} active={active} owner={owner as RefObject<HTMLElement | null>} onDetailsOpenChange={occupied} parentUnavailable={parentUnavailable} /></div></CurrentAccountProvider>;
};
const render = (ui = <Harness />) => renderWithLocale(ui, { locale: 'zh-CN', taskCache: true });

it('round trips the Discussion deep link through the runtime route parser', () => {
  const url = taskDetailUrl(projectId, taskId, { tab: 'discussion', path: null });
  expect(url).toBe(`/projects/${projectId}/tasks/${taskId}?tab=discussion`);
  expect(parseRoute(new URL(url, location.origin).pathname, '?tab=discussion')).toEqual({ kind: 'task', projectId, taskId, tab: 'discussion', path: null });
});

it('gates hidden reads and retains the same task draft across tabs', async () => {
  const fetcher = vi.fn(async (_url: string) => page([])); vi.stubGlobal('fetch', fetcher);
  const view = render(<Harness active={false} />);
  await act(async () => {}); expect(fetcher).not.toHaveBeenCalled();
  view.rerender(<Harness active />);
  await screen.findByText('还没有讨论');
  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(String(fetcher.mock.calls[0]![0]), location.origin);
  expect(url.searchParams.get('details')).toBe('true');
  fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: '  draft\n' } });
  view.rerender(<Harness active={false} />); view.rerender(<Harness active />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('textbox', { name: '讨论消息' })).toHaveValue('  draft\n');
});

it('uses historical provider snapshots and sends a raw human reply without claim context', async () => {
  const original = message(1, 'Original message', { author: { userId: id(300), displayName: 'Historical', Agent: true, execution: { provider: 'codex', workerId: id(301), claimId: id(302) } } });
  let submitted: Record<string, unknown> | null = null;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return page([original]);
    submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
    return resource(message(2, String(submitted.body), { replyTo: String(submitted.replyTo) }), 201);
  }); vi.stubGlobal('fetch', fetcher);
  render(); await screen.findByText('Original message');
  expect(screen.getByText('Codex')).toBeVisible(); expect(screen.getByText('Historical 的 Agent')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '回复 Historical 的 Agent' }));
  const raw = '  leading\n\n```ts\n  const value = 1;\n```\n  ';
  fireEvent.change(screen.getByRole('textbox', { name: '讨论消息' }), { target: { value: raw } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  expect(submitted).toEqual({ body: raw, replyTo: original.id });
  fireEvent.click(screen.getAllByRole('button', { name: '消息详情' })[1]!);
  const dialog = screen.getByRole('dialog', { name: '消息详情' });
  expect(within(dialog).getByLabelText('消息正文').textContent).toBe(raw);
  expect(within(dialog).getByText('false')).toBeVisible();
});

it('keeps an unknown send draft and never replays it during refresh', async () => {
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { if (init?.method === 'POST') throw new TypeError('Connection closed'); return page([]); }); vi.stubGlobal('fetch', fetcher);
  render(); await screen.findByText('还没有讨论');
  const raw = '  unknown\n\n';
  fireEvent.change(screen.getByRole('textbox'), { target: { value: raw } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('发送结果未知。');
  fireEvent.click(screen.getByRole('button', { name: '刷新讨论' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
  expect(screen.getByRole('textbox')).toHaveValue(raw);
});

it('settles a confirmed post while admission is blocked and preserves later editing', async () => {
  const original = message(1, 'Original'), receipt = message(2, 'Submitted', { replyTo: original.id });
  let resolvePost!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolvePost = resolve; });
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? pending : page([original]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(); await screen.findByText('Original');
  fireEvent.click(screen.getByRole('button', { name: '回复 Alice' }));
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'Submitted' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
  view.rerender(<Harness admissionBlocked />);
  await act(async () => { resolvePost(resource(receipt, 201)); });
  expect(input).toHaveValue('Submitted'); expect(view.container.querySelector('.thread-reply-preview')).not.toBeNull();
  expect(view.container.querySelector('.thread-timeline')).not.toHaveTextContent('Submitted');
  fireEvent.change(input, { target: { value: 'New draft' } });
  expect(fetcher).toHaveBeenCalledTimes(2);
  view.rerender(<Harness />); await waitFor(() => expect(view.container.querySelector('.thread-timeline')).toHaveTextContent('Submitted'));
  expect(input).toHaveValue('New draft'); expect(view.container.querySelector('.thread-reply-preview')).not.toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('shows an unknown result after a dispatched post fails during admission pause', async () => {
  let rejectPost!: (error: Error) => void;
  const pending = new Promise<Response>((_resolve, reject) => { rejectPost = reject; });
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? pending : page([message(1, 'Original')]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(); await screen.findByText('Original');
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'Keep me' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
  view.rerender(<Harness admissionBlocked />);
  await act(async () => { rejectPost(new TypeError('Connection closed')); });
  expect(await screen.findByText('发送结果未知。')).toBeVisible(); expect(input).toHaveValue('Keep me');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('preserves the submitted draft if the user leaves the discussion before confirmation', async () => {
  let resolvePost!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { resolvePost = resolve; });
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? pending : page([message(1, 'Original')]));
  vi.stubGlobal('fetch', fetcher);
  const view = render(); await screen.findByText('Original');
  const input = screen.getByRole('textbox'); fireEvent.change(input, { target: { value: 'Submitted' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1));
  view.rerender(<Harness active={false} />);
  await act(async () => { resolvePost(resource(message(2, 'Submitted'), 201)); });
  view.rerender(<Harness active />);
  expect(input).toHaveValue('Submitted'); expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('shows a real refusal separately from an unknown send', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? resource({ error: { code: 'payload_too_large', message: 'private upstream detail', requestId: 'refused-request' } }, 413) : page([])));
  render(); await screen.findByText('还没有讨论');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retained draft' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('消息未发送。'); expect(screen.getByRole('textbox')).toHaveValue('Retained draft'); expect(screen.getByRole('button', { name: '重新发送' })).toBeEnabled(); expect(screen.queryByText('private upstream detail')).toBeNull();
  fireEvent.click(screen.getByText('错误详情')); expect(screen.getByText('refused-request')).toBeVisible(); expect(screen.getByText('payload_too_large')).toBeVisible();
});

it('resolves an off-window quote only on demand with the exact two bounded reads', async () => {
  const parent = message(2, 'Parent from history'), predecessor = message(1, 'Predecessor'), reply = message(3, 'Visible reply', { replyTo: parent.id });
  const fetcher = vi.fn(async (url: string) => {
    const query = new URL(url, location.origin).searchParams;
    if (query.get('beforeId') === parent.id) return page([predecessor], false, true);
    if (query.get('afterId') === predecessor.id) return page([parent], true, true);
    return page([reply], true);
  }); vi.stubGlobal('fetch', fetcher);
  render(); await screen.findByText('Visible reply');
  expect(fetcher).toHaveBeenCalledTimes(1); expect(screen.getByText(parent.id)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '查看引用消息' }));
  await screen.findByText('Parent from history');
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const [url] of fetcher.mock.calls.slice(1)) { const query = new URL(url, location.origin).searchParams; expect(query.get('count')).toBe('1'); expect(query.get('details')).toBe('true'); }
});

it('owns nested Escape and Tab and restores the opener without reaching the parent', async () => {
  const original = message(1, 'Keyboard message'), occupied = vi.fn(); let childOpen = false;
  occupied.mockImplementation((value: boolean) => { childOpen = value; });
  const parentKey = vi.fn((event: KeyboardEvent) => { if (!childOpen && !event.defaultPrevented) throw new Error('Parent handled child keyboard event'); });
  document.addEventListener('keydown', parentKey);
  vi.stubGlobal('fetch', vi.fn(async () => page([original])));
  const view = render(<Harness occupied={occupied} />); await screen.findByText('Keyboard message');
  const opener = screen.getByRole('button', { name: '消息详情' }); opener.focus(); fireEvent.click(opener);
  const close = screen.getByRole('button', { name: '关闭消息详情' }); expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: 'Tab' }); expect(close).toHaveFocus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(close).toHaveFocus(); expect(parentKey).not.toHaveBeenCalled();
  fireEvent.keyDown(close, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(opener).toHaveFocus(); expect(occupied.mock.calls.map(([open]) => open)).toEqual([true, false]); expect(parentKey).not.toHaveBeenCalled();
  view.unmount(); document.removeEventListener('keydown', parentKey);
});

it('renders missing names as account identity and blocks Markdown resource/unsafe URL loading', async () => {
  const original = message(1, '[bad](javascript:alert(1)) ![secret](https://example.test/secret.png)\n\n| A | B |\n| - | - |\n| x | y |', { author: { userId: TEST_VIEWER_ID, displayName: '  ', Agent: false } });
  const fetcher = vi.fn(async () => page([original])); vi.stubGlobal('fetch', fetcher);
  render(); await screen.findByText(`账号 ${TEST_VIEWER_ID}`);
  expect(screen.queryByRole('img', { name: 'secret' })).toBeNull(); expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
  expect(screen.getByRole('region', { name: '表格' })).toBeVisible(); expect(fetcher).toHaveBeenCalledTimes(1);
});


it('retains the same details dialog and reading state through account revalidation', async () => {
  const first = message(1, 'Retained while checking'), receipt = message(2, 'Submitted message');
  let resolveRead!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveRead = resolve; });
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? resource(receipt, 201) : fetcher.mock.calls.filter(([, options]) => options?.method !== 'POST').length === 1 ? page([first], true) : pending);
  vi.stubGlobal('fetch', fetcher);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal'), occupied = vi.fn();
  const view = render(<Harness occupied={occupied} />); await screen.findByText(first.body);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: receipt.body } }); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText(receipt.body);
  fireEvent.click(screen.getAllByRole('button', { name: '回复 Alice' })[0]!);
  fireEvent.change(input, { target: { value: 'Keep my draft' } }); input.setSelectionRange(2, 6);
  const reply = view.container.querySelector('.thread-reply-preview')!, timeline = view.container.querySelector<HTMLDivElement>('.thread-timeline')!;
  timeline.scrollTop = 42;
  fireEvent.click(screen.getAllByRole('button', { name: '消息详情' })[1]!);
  const dialog = screen.getByRole('dialog') as HTMLDialogElement, close = screen.getByRole('button', { name: '关闭消息详情' });
  const body = dialog.querySelector<HTMLDivElement>('.thread-metadata-body')!, owner = view.container.querySelector('.task-discussion')!.parentElement!;
  body.scrollTop = 31;
  const assertRetained = () => {
    expect(screen.getByRole('dialog')).toBe(dialog); expect(dialog).toBeVisible(); expect(dialog.open).toBe(true);
    expect(dialog.querySelector('.thread-metadata-body')).toBe(body); expect(body.scrollTop).toBe(31); expect(timeline.scrollTop).toBe(42);
    expect(close).toHaveFocus(); expect(owner).toHaveAttribute('inert'); expect(occupied.mock.calls.map(([open]) => open)).toEqual([true]);
    expect(showModal).toHaveBeenCalledTimes(1); expect(view.container.querySelector('.thread-reply-preview')).toBe(reply);
    expect(input).toHaveValue('Keep my draft'); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  };
  assertRetained();
  visibility.mockReturnValue('hidden'); fireEvent(document, new Event('visibilitychange')); assertRetained();
  view.rerender(<Harness occupied={occupied} admissionBlocked />); assertRetained(); expect(input).toBeEnabled();
  visibility.mockReturnValue('visible'); fireEvent(document, new Event('visibilitychange')); assertRetained();
  view.rerender(<Harness occupied={occupied} />); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3)); assertRetained();
  await act(async () => { resolveRead(page([{ ...receipt, author: { ...receipt.author } }])); });
  await waitFor(() => expect(input).toBeEnabled()); assertRetained();
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  view.unmount(); visibility.mockRestore(); showModal.mockRestore();
});

it('allows editing a loaded draft during revalidation without dispatching a post', async () => {
  let resolveRead!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveRead = resolve; });
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST' ? resource(message(2, 'Unexpected'), 201) : fetcher.mock.calls.length === 1 ? page([message(1, 'Loaded')]) : pending);
  vi.stubGlobal('fetch', fetcher);
  const view = render(); await screen.findByText('Loaded');
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'original draft' } }); input.focus(); input.setSelectionRange(2, 8);
  view.rerender(<Harness admissionBlocked />);
  expect(input).toBeEnabled(); expect(input).toHaveFocus(); expect([input.selectionStart, input.selectionEnd]).toEqual([2, 8]);
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  fireEvent.change(input, { target: { value: 'edited during checking' } }); input.setSelectionRange(7, 13);
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
  view.rerender(<Harness />); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(input).toHaveFocus(); expect(input).toHaveValue('edited during checking'); expect([input.selectionStart, input.selectionEnd]).toEqual([7, 13]);
  await act(async () => { resolveRead(page([])); });
  expect(input).toHaveFocus(); expect(input).toHaveValue('edited during checking'); expect([input.selectionStart, input.selectionEnd]).toEqual([7, 13]);
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});

it('keeps the first load disabled while allowing an already loaded empty discussion to be edited', async () => {
  let resolveRead!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { resolveRead = resolve; });
  const fetcher = vi.fn(async () => pending); vi.stubGlobal('fetch', fetcher);
  const view = render(<Harness admissionBlocked />);
  const input = screen.getByRole('textbox'); expect(input).toBeDisabled(); expect(fetcher).not.toHaveBeenCalled();
  view.rerender(<Harness />); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); expect(input).toBeDisabled();
  await act(async () => { resolveRead(page([])); }); await screen.findByText('还没有讨论');
  expect(input).toBeEnabled();
  view.rerender(<Harness admissionBlocked />); expect(input).toBeEnabled();
  fireEvent.change(input, { target: { value: 'Draft in empty discussion' } });
  expect(input).toHaveValue('Draft in empty discussion'); expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('retires details without restoring focus to a hidden or unavailable task', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => page([message(1, 'Retired task')])));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'), occupied = vi.fn();
  const view = render(<Harness occupied={occupied} />); await screen.findByText('Retired task');
  const opener = screen.getByRole('button', { name: '消息详情' }); opener.focus(); fireEvent.click(opener);
  const focus = vi.spyOn(opener, 'focus');
  visibility.mockReturnValue('hidden'); fireEvent(document, new Event('visibilitychange'));
  expect(screen.getByRole('dialog')).toBeVisible();
  view.rerender(<Harness occupied={occupied} parentUnavailable />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(focus).not.toHaveBeenCalled();
  expect(occupied.mock.calls.map(([open]) => open)).toEqual([true, false]); expect(screen.queryByText('Retired task')).toBeNull();
  view.unmount(); visibility.mockRestore();
});

it('keeps reference-window history reachable after viewing a disconnected own receipt', async () => {
  const item = (value: number, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
    id: id(value), author: { userId: TEST_VIEWER_ID, displayName: 'Alice', Agent: false },
    body: `Message ${value}\n\n${'Reading text. '.repeat(60)}`,
    createdAt: `2026-11-04T10:00:00.${String(value).padStart(3, '0')}Z`, ...extra,
  });
  const reference = item(10), latest = item(151, { replyTo: reference.id }), receipt = item(200);
  let posted = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posted = true; return resource(receipt, 201); }
    const query = new URL(url, location.origin).searchParams;
    if (query.get('beforeId') === reference.id) return page([item(9)], false, true);
    if (query.get('afterId') === id(9)) return page([reference], true, true);
    if (query.get('afterId') === reference.id) return page([item(11), item(12), latest], true, true);
    if (query.get('afterId') === latest.id) return posted ? page([item(152), receipt], true, false) : page([]);
    if (query.get('afterId') === receipt.id) return page([]);
    return page([latest], true, false);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render();
  const box = view.container.querySelector<HTMLDivElement>('.thread-timeline')!;
  Object.defineProperties(box, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => box.querySelectorAll('[data-entry-key]').length * 500 },
  });
  vi.spyOn(box, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 400, 200));
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.matches('[data-entry-key]')) return originalRect.call(this);
    const top = [...box.querySelectorAll('[data-entry-key]')].indexOf(this) * 500 - box.scrollTop;
    return new DOMRect(0, top, 400, 500);
  });
  await screen.findByText(/^Message 151/);
  fireEvent.click(screen.getByRole('button', { name: '查看引用消息' }));
  await screen.findByText(/^Message 10/);
  fireEvent.wheel(box, { deltaY: -10 }); box.scrollTop = 100; fireEvent.scroll(box);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: receipt.body } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
  expect(screen.getByText(/^Message 200/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /\d+ 条新消息/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看新消息' }));
  await screen.findByRole('button', { name: '1 条新消息' });
  fireEvent.click(screen.getByRole('button', { name: '加载较新的消息' }));
  await screen.findByText(/^Message 11\b/, { selector: '.thread-message-markdown p' }); expect(screen.getByText(/^Message 12\b/, { selector: '.thread-message-markdown p' })).toBeVisible(); expect(screen.getByText(/^Message 151\b/, { selector: '.thread-message-markdown p' })).toBeVisible();
  expect(fetcher.mock.calls.some(([url]) => new URL(url, location.origin).searchParams.get('afterId') === reference.id)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '加载较新的消息' }));
  await screen.findByText(/^Message 152\b/);
  fireEvent.click(screen.getByRole('button', { name: '加载较早的消息' }));
  await screen.findByText(/^Message 9\b/);
  for (const value of [10, 11, 12, 151, 152, 200]) expect(screen.getByText(new RegExp(`^Message ${value}\\b`), { selector: '.thread-message-markdown p' })).toBeVisible();
});
