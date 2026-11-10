import { useRef, type ReactNode } from 'react';
import { sessionImageBytes } from './helpers/sessionImages';
import { SessionImageStore } from '../src/features/task-agent-session/images/image-store';
import { SessionImageScope } from '../src/features/task-agent-session/images/SessionImageScope';
import { readFileSync } from 'node:fs';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SessionOperation, SessionSnapshot, TimelineEntry } from '../src/api/types';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState, mergeTimeline, type SessionState } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('en');
const props = { active: true, canRespond: false, onRespond: async () => {}, hasOlder: false, loadingOlder: false, onLoadOlder: async () => {}, onLoadResource: async () => new Blob() };
const base = (id: string) => ({ entryId: id, entrySeq: id, revision: '1' });
const message = (id: string): TimelineEntry => ({ ...base(id), kind: 'assistant_message', content: [{ type: 'text', text: 'Before **image**' }, { type: 'resource', resourceId: 'image', label: 'Message image' }, { type: 'text', text: 'After image' }, { type: 'resource', resourceId: 'file', label: 'Message file' }] });
const tool = (id: string, name = 'shell'): TimelineEntry => ({ ...base(id), kind: 'tool_call', callId: id, name, input: 'inspect', output: [{ type: 'resource', resourceId: 'tool-image', label: 'Tool image' }], status: 'completed', truncated: false });
const keys = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>('[data-entry-key]'), node => node.dataset.entryKey);

it('keeps the internal Standard default and explicitly filters Conversation without replacing retained nodes or state', () => {
  const entries: TimelineEntry[] = [
    message('1'), tool('2'), { ...base('3'), kind: 'reasoning', text: 'Thinking' },
    { ...base('4'), kind: 'compaction', summary: 'Compacted' },
    { ...base('5'), kind: 'todo', items: [{ id: 'todo', text: 'Read plan', status: 'pending' }] },
    ...['update_plan', 'TodoWrite', 'todo_write', 'EnterPlanMode', 'ExitPlanMode', 'enter_plan_mode', 'exit_plan_mode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].map((name, i) => tool(String(i + 6), `functions.${name}`)),
    { ...base('17'), kind: 'error', code: 'unsupported_native_item', message: 'Unsupported native timeline item: subAgentActivity. {"type":"subAgentActivity","id":"child"}' },
    { ...base('18'), kind: 'error', code: 'provider_error', message: 'Real failure' },
    { ...base('19'), kind: 'reasoning', text: '  ' },
    { ...base('20'), kind: 'user_message', content: [{ type: 'text', text: 'User question' }] },
  ];
  const state = { ...emptySessionState(), entries };
  const before = JSON.stringify(state.entries), onRespond = vi.fn(), onLoadResource = vi.fn();
  const view = render(<SessionTimeline state={state} {...props} onRespond={onRespond} onLoadResource={onLoadResource} />);
  expect(keys(view.container)).toEqual(entries.filter(entry => entry.entryId !== '19').map(entry => entry.entryId));
  const retained = view.container.querySelector('[data-entry-key="1"]');
  view.rerender(<SessionTimeline state={state} {...props} displayMode="conversation" onRespond={onRespond} onLoadResource={onLoadResource} />);
  expect(keys(view.container)).toEqual(['1', '5', ...Array.from({ length: 11 }, (_, i) => String(i + 6)), '18', '20']);
  expect(view.container.querySelector('[data-entry-key="1"]')).toBe(retained);
  expect(screen.getByText('Real failure')).toBeVisible();
  expect(screen.getByText(/Message image/)).toBeVisible();
  expect(screen.getByText(/Message file/)).toBeVisible();
  expect(screen.getByText('After image')).toBeVisible();
  expect(screen.queryByText(/Tool image/)).toBeNull();
  view.rerender(<SessionTimeline state={state} {...props} displayMode="standard" onRespond={onRespond} onLoadResource={onLoadResource} />);
  expect(keys(view.container)).toEqual(entries.filter(entry => entry.entryId !== '19').map(entry => entry.entryId));
  expect(view.container.querySelector('[data-entry-key="1"]')).toBe(retained);
  expect(JSON.stringify(state.entries)).toBe(before);
  expect(onRespond).not.toHaveBeenCalled(); expect(onLoadResource).not.toHaveBeenCalled();
});

it('unmounts expanded hidden output and restores it from existing data on demand', async () => {
  const state = { ...emptySessionState(), entries: [tool('1')] };
  const view = render(<SessionTimeline state={state} {...props} displayMode="standard" />);
  const expand = async () => {
    const details = view.container.querySelector('details')!;
    details.open = true; fireEvent(details, new Event('toggle'));
    await screen.findByText(/Tool image/);
  };
  await expand();
  view.rerender(<SessionTimeline state={state} {...props} displayMode="conversation" />);
  expect(view.container.querySelector('details')).toBeNull();
  expect(screen.queryByText(/Tool image/)).toBeNull();
  expect(screen.getByText('No content in conversation mode.')).toBeVisible();
  view.rerender(<SessionTimeline state={state} {...props} displayMode="standard" />);
  await expand();
});

it('retains verified mixed message resources without loading hidden tool resources', async () => {
  const bytes = sessionImageBytes('png'), sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const descriptor = { revision: '1', width: 3, height: 2, frameCount: 1, name: 'asset.png', status: 'available' as const, mediaType: 'image/png', byteLength: String(bytes.length), sha256, error: null };
  const state = { ...emptySessionState(), entries: [message('1'), tool('2'), tool('3', 'update_plan')], resources: new Map([
    ['image', { ...descriptor, resourceId: 'image' }], ['file', { ...descriptor, resourceId: 'file', mediaType: 'text/plain' }], ['tool-image', { ...descriptor, resourceId: 'tool-image' }],
  ]) };
  const load = vi.fn(async (_id: string, _signal: AbortSignal) => new Response(bytes, { headers: { 'Content-Type': 'image/png' } }).blob());
  // The decoder is controlled here; production browser tests own pixel validation.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3, height: 2, close: vi.fn() })));
  const store = new SessionImageStore(), scope = store.createScope({ identity: { serverOrigin: 'https://daynight.test', actorUserId: 'reader', authorizationGeneration: '1', owner: { kind: 'record', namespace: 'display-test', recordId: 'record', revision: '1' } }, canRead: () => true, canDownload: () => true, read: load });
  function Owner({ children }: { readonly children: ReactNode }) { const root = useRef<HTMLElement>(null); return <section ref={root}><SessionImageScope scope={scope} active rootRef={root}>{children}</SessionImageScope></section>; }
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:verified');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const view = render(<Owner><SessionTimeline state={state} {...props} displayMode="conversation" onLoadResource={load} /></Owner>);
  const image = await screen.findByRole('img', { name: 'Message image' });
  expect(image).toHaveAttribute('src', 'blob:verified');
  expect(screen.getByRole('button', { name: 'Download: Message file' })).toBeVisible();
  expect(load.mock.calls.map(call => call[0])).toEqual(['image']);
  const details = screen.getByText('update_plan').closest('details')!;
  details.open = true; fireEvent(details, new Event('toggle'));
  await screen.findByRole('img', { name: 'Tool image' });
  expect(load.mock.calls.map(call => call[0])).toEqual(['image', 'tool-image']);
  view.rerender(<Owner><SessionTimeline state={state} {...props} displayMode="standard" onLoadResource={load} /></Owner>);
  expect(screen.getByRole('img', { name: 'Message image' })).toBe(image);
  expect(load).toHaveBeenCalledTimes(2);
  view.unmount(); await store.close();
});

it('keeps loading and errors visible when Conversation filters every entry', async () => {
  const state: SessionState = { ...emptySessionState(), entries: [tool('30'), tool('20')] };
  const load = vi.fn(async () => {});
  const view = render(<SessionTimeline state={state} {...props} displayMode="conversation" hasOlder historyReady loadingOlder onLoadOlder={load} />);
  expect(screen.getByText('No content in conversation mode.')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Loading earlier activity');
  expect(screen.queryByRole('button', { name: 'Load earlier activity' })).toBeNull();
  view.rerender(<SessionTimeline state={state} {...props} displayMode="conversation" hasOlder historyReady historyError="Earlier activity failed" onLoadOlder={load} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Earlier activity failed');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  const visible = { ...state, entries: mergeTimeline(state.entries, [message('1')]) };
  view.rerender(<SessionTimeline state={visible} {...props} displayMode="conversation" onLoadOlder={load} />);
  expect(keys(view.container)).toEqual(['1']);
  expect(screen.queryByText('No content in conversation mode.')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  view.rerender(<SessionTimeline state={visible} {...props} displayMode="standard" onLoadOlder={load} />);
  expect(keys(view.container)).toEqual(['1', '20', '30']);
  expect(load).not.toHaveBeenCalled();
});

it('localizes the Conversation empty state independently of the Standard empty state', () => {
  const view = createLocaleRender('zh-CN')(<SessionTimeline state={{ ...emptySessionState(), entries: [tool('1')] }} {...props} displayMode="conversation" />);
  expect(screen.getByText('当前对话模式下暂无内容')).toBeVisible();
  view.rerender(<SessionTimeline state={emptySessionState()} {...props} displayMode="standard" />);
  expect(screen.getByText('尚无对话。')).toBeVisible();
});

it.each(['en', 'zh-CN'] as const)('shows genuinely empty history in both modes in %s', locale => {
  const view = createLocaleRender(locale)(<SessionTimeline state={emptySessionState()} {...props} displayMode="conversation" />);
  const empty = locale === 'en' ? 'No conversation yet.' : '尚无对话。';
  expect(screen.getByText(empty)).toBeVisible();
  view.rerender(<SessionTimeline state={emptySessionState()} {...props} displayMode="standard" />);
  expect(screen.getByText(empty)).toBeVisible();
});

it('keeps the filtered message until empty history is known to be complete', () => {
  const view = render(<SessionTimeline state={emptySessionState()} {...props} displayMode="conversation" hasOlder />);
  expect(screen.getByText('No content in conversation mode.')).toBeVisible();
  view.rerender(<SessionTimeline state={emptySessionState()} {...props} displayMode="conversation" hasOlder historyComplete />);
  expect(screen.getByText('No conversation yet.')).toBeVisible();
  view.rerender(<SessionTimeline state={{ ...emptySessionState(), entries: [tool('1')] }} {...props} displayMode="conversation" historyComplete />);
  expect(screen.getByText('No content in conversation mode.')).toBeVisible();
});

it.each([{ entries: [] }, { entries: [tool('1')] }])('honors suppressed empty content with $entries.length entries', ({ entries }) => {
  const view = render(<SessionTimeline state={{ ...emptySessionState(), entries }} {...props} displayMode="conversation" suppressEmpty />);
  expect(view.container.querySelector('.session-empty')).toBeNull();
});

it('preserves interaction state, response gating and pending operations across mode changes', async () => {
  const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const interaction = { interactionId: 'approval', revision: '1', state: 'pending', title: 'Approve', kind: 'approval', detail: 'Details', actions: ['allow_once'] } as const;
  const state = { ...emptySessionState(), snapshot: { ...snapshot, lifecycle: 'active' as const, synchronized: true, connectionState: 'connected' as const, capabilities: { ...snapshot.capabilities, respond: true }, operations: { ...snapshot.operations, canRespond: true } }, entries: [tool('1'), { ...base('2'), kind: 'interaction' as const, interaction }, { ...base('3'), kind: 'interaction' as const, interaction: { ...interaction, interactionId: 'resolved', state: 'resolved' as const } }] };
  let settle!: () => void;
  const respond = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
  const view = render(<SessionTimeline state={state} {...props} canRespond displayMode="standard" onRespond={respond} />);
  const button = screen.getByRole('button', { name: 'Allow once' });
  view.rerender(<SessionTimeline state={state} {...props} canRespond displayMode="conversation" onRespond={respond} />);
  expect(screen.getByRole('button', { name: 'Allow once' })).toBe(button);
  expect(respond).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(respond).toHaveBeenCalledTimes(1);
  view.rerender(<SessionTimeline state={state} {...props} canRespond displayMode="standard" onRespond={respond} />);
  expect(button).toBeDisabled();
  expect(respond).toHaveBeenCalledTimes(1);
  settle(); await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull());
  expect(screen.getAllByText('Resolved')).toHaveLength(2);
});

it.each(['pending', 'disconnected', 'readOnly', 'recovering'] as const)('does not re-enable a %s response when filtering', reason => {
  const snapshot: SessionSnapshot = JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8'));
  const operation: SessionOperation = { ...JSON.parse(readFileSync('../daynight/test/session/fixtures/operation.json', 'utf8')), kind: 'interaction_response', state: 'unknown' };
  const interaction = { interactionId: 'approval', revision: '1', state: 'pending', title: 'Approve', kind: 'approval', detail: 'Details', actions: ['allow_once'] } as const;
  const state: SessionState = { ...emptySessionState(), snapshot: { ...snapshot, lifecycle: reason === 'readOnly' ? 'draining' : 'active', synchronized: true, connectionState: 'connected', capabilities: { ...snapshot.capabilities, respond: true }, operations: { ...snapshot.operations, canRespond: true } }, recoveryRequired: reason === 'recovering', entries: [{ ...base('1'), kind: 'interaction', interaction }], operations: reason === 'pending' ? new Map([[operation.operationId, operation]]) : new Map(), responseTargets: new Map([[operation.operationId, interaction]]) };
  const respond = vi.fn();
  const view = render(<SessionTimeline state={state} {...props} canRespond={reason !== 'disconnected'} displayMode="standard" onRespond={respond} />);
  expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
  view.rerender(<SessionTimeline state={state} {...props} canRespond={reason !== 'disconnected'} displayMode="conversation" onRespond={respond} />);
  const button = screen.getByRole('button', { name: 'Allow once' });
  expect(button).toBeDisabled(); fireEvent.click(button); expect(respond).not.toHaveBeenCalled();
});
