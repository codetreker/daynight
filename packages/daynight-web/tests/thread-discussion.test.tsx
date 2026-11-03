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
const Harness = ({ active = true, occupied = () => {}, admissionBlocked = false }: { readonly active?: boolean; readonly occupied?: (value: boolean) => void; readonly admissionBlocked?: boolean }) => {
  const owner = useRef<HTMLDivElement>(null);
  return <CurrentAccountProvider user={{ id: TEST_VIEWER_ID, name: 'Current Alice' }} admissionBlocked={admissionBlocked}><div ref={owner}><TaskDiscussion projectId={projectId} taskId={taskId} active={active} owner={owner as RefObject<HTMLElement | null>} onDetailsOpenChange={occupied} /></div></CurrentAccountProvider>;
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


it('closes details during account revalidation while keeping task data and the draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => page([message(1, 'Retained while checking')])));
  const view = render(); await screen.findByText('Retained while checking');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } });
  fireEvent.click(screen.getByRole('button', { name: '消息详情' })); expect(screen.getByRole('dialog')).toBeVisible();
  view.rerender(<Harness admissionBlocked />);
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.getByRole('textbox')).toHaveValue('Keep my draft'); expect(screen.getByRole('textbox')).toBeDisabled(); expect(screen.getByText('Retained while checking')).toBeVisible();
  view.rerender(<Harness />); await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
});
