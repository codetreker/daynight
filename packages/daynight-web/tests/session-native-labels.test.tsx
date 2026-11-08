import { readFileSync } from 'node:fs';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SessionSnapshot, SessionOperation, TimelineEntry } from '../src/api/types';
import type { SessionControls } from '../../daynight/src/session/controls';
import type { TaskSessionClient, SessionViewState } from '../src/features/task-agent-session/client';
import { SessionView } from '../src/features/task-agent-session/SessionView';
import { SessionActivity } from '../src/features/task-agent-session/SessionActivity';
import { SessionComposer } from '../src/features/task-agent-session/SessionComposer';
import { SessionTimeline } from '../src/features/task-agent-session/SessionTimeline';
import { emptySessionState, hydrateSession } from '../src/features/task-agent-session/state';
import { createLocaleRender } from './helpers/renderWithLocale';

const render = createLocaleRender('zh-CN');
const snapshot = (patch: Partial<SessionSnapshot> = {}): SessionSnapshot => ({ ...JSON.parse(readFileSync('../daynight/test/session/fixtures/snapshot.json', 'utf8')), turnStartedAt: null, ...patch });
const state = (s = snapshot()) => hydrateSession(emptySessionState(), s, []);
const controls: SessionControls = { revision: '3', settings: [{ id: 'permissions', category: 'permission', label: 'Approval policy', description: 'Native description', value: 'ask', mutable: true, scope: 'session', options: [{ value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow' }] }], commands: [{ id: 'compact', name: 'compact', description: 'Compact context', argumentHint: null, available: true }], settingsError: null, commandsError: null };
const composer = (s = snapshot({ controls })) => ({ state: state(s), connected: true, onSend: vi.fn(async () => {}), onCancel: vi.fn(async () => {}), onExecuteCommand: vi.fn(async () => {}), onUpdateSetting: vi.fn(async () => {}), onRefreshControls: vi.fn(async () => {}) });
const operation = (s: SessionSnapshot): SessionOperation => ({ protocol: s.protocol, sessionId: s.sessionId, claimId: 'claim', executionGeneration: s.executionGeneration, operationId: 'unknown', kind: 'send_message', state: 'unknown', providerResult: null, error: null });
function viewClient(s: SessionSnapshot, connected = true, operations = new Map<string, SessionOperation>()) {
  const view: SessionViewState = { operationProgress: new Map(), startupReport: null, errorCode: null, environmentConnected: true, historyReady: true, historyRevision: 1, connectionGeneration: 1, state: { ...state(s), operations }, archiveState: 'ready', settingIntents: new Map(), draft: { text: '', revision: '1', submission: null }, status: 'ready', connected, authPaused: false, error: null, hasOlder: false, loadingOlder: false, historyError: null, checking: new Set() };
  return { snapshot: () => view, canInteract: () => true, subscribe: () => () => {}, refresh: vi.fn(), checkOperation: vi.fn(), respond: vi.fn(), loadOlder: vi.fn(), resource: vi.fn(), setDraft: vi.fn(), send: vi.fn(), cancel: vi.fn(), updateSetting: vi.fn(), executeCommand: vi.fn(), refreshControls: vi.fn() } as unknown as TaskSessionClient;
}
const activities = [ ['idle', 'Ready'], ['working', 'Working'], ['waiting_input', 'Waiting for an answer'], ['stopped', 'Stopped'], ['unknown', 'Outcome unknown'] ] as const;
it.each(activities)('keeps header and visible footer %s labels English through locale changes', (activity, label) => {
  const s = snapshot({ activity });
  const view = render(<><SessionView userId="00000009-1111-4111-8111-111111111111" client={viewClient(s)} active current /><SessionActivity snapshot={s} connected active commandPending={false} interruptRequested={false} interruptPending interruptAllowed={false} onInterrupt={vi.fn()} /></>);
  for (const locale of ['zh-CN', 'en', 'zh-CN'] as const) {
    view.setLocale(locale);
    const header = view.container.querySelector('.session-header .session-status')!;
    expect(header).toHaveTextContent(label); expect(header).toHaveAttribute('lang', 'en');
    for (const footer of view.container.querySelectorAll('.session-composer-activity [aria-live]')) { expect(footer).toHaveTextContent(label); expect(footer).toHaveAttribute('lang', 'en'); }
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', locale === 'en' ? 'Message the agent…' : '向 Agent 发送消息…');
  }
});
it.each([
  [{ connectionState: 'disconnected' }, true, '执行环境连接中断', 'Execution environment disconnected'],
  [{ connectionState: 'synchronizing' }, true, '正在同步会话', 'Synchronizing session'],
  [{ synchronized: false }, true, '正在同步会话', 'Synchronizing session'],
  [{}, false, '正在同步会话', 'Synchronizing session'],
] as const)('localizes a single connection status in the header (%j, connected=%s)', (patch, connected, zh, en) => {
  const s = snapshot({ activity: 'working', ...patch });
  const view = render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={viewClient(s, connected)} active current />);
  for (const locale of ['zh-CN', 'en'] as const) {
    view.setLocale(locale);
    expect(view.container.querySelector('.session-header .session-status')).toHaveTextContent(locale === 'en' ? en : zh);
    expect(view.container.querySelector('.session-composer-activity [aria-live]')).toBeNull();
  }
});
it('keeps the ready archive status only in the English header across locales', () => {
  const view = render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={viewClient(snapshot({ lifecycle: 'archived' }))} active current />);
  expect(view.container.querySelector('.session-header .session-status')).toHaveTextContent('Completed · Read-only history');
  expect(screen.queryByText('已结束 · 只读历史')).toBeNull();
  view.setLocale('en');
  expect(screen.getAllByText('Completed · Read-only history')).toHaveLength(1);
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('keeps unknown operation receipts localized independently of the activity label', () => {
  const s = snapshot({ activity: 'unknown' }), op = operation(s);
  const view = render(<SessionView userId="00000009-1111-4111-8111-111111111111" client={viewClient(s, true, new Map([[op.operationId, op]]))} active current />);
  expect(view.container.querySelector('.session-header .session-status')).toHaveTextContent('Outcome unknown');
  expect(within(view.container.querySelector('.session-receipts') as HTMLElement).getByText('无法确认此操作是否完成，请核对原操作。')).toBeVisible();
  expect(screen.getByRole('button', { name: '核对原操作' })).toBeVisible();
  view.setLocale('en');
  expect(within(view.container.querySelector('.session-receipts') as HTMLElement).getByText('Unable to confirm whether this operation completed. Check the original operation.')).toBeVisible();
});
it('keeps Permissions trigger English while the panel, errors, and draft remain localized', async () => {
  const props = composer(); props.onUpdateSetting.mockRejectedValue(null);
  const view = render(<SessionComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '未发送的内容' } });
  const trigger = screen.getByRole('button', { name: 'Permissions' });
  expect(trigger).toHaveTextContent('Permissions'); expect(trigger).toHaveAttribute('lang', 'en');
  fireEvent.click(trigger);
  expect(screen.getByLabelText('权限设置')).toBeVisible();
  expect(screen.getByText('设置值以 Provider 确认为准。')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'allow' } });
  expect(await screen.findByText('操作失败。')).toBeVisible();
  expect(props.onUpdateSetting).toHaveBeenCalledWith('permissions', 'allow', '3');
  view.setLocale('en');
  expect(screen.getByRole('button', { name: 'Permissions' })).toBe(trigger);
  expect(screen.getByLabelText('Permission settings')).toBeVisible();
  expect(screen.getByText('Values change after provider confirmation.')).toBeVisible();
  expect(screen.getByRole('textbox')).toHaveValue('未发送的内容');
  expect(props.onSend).not.toHaveBeenCalled();
});
it.each([false, true])('keeps submit and pending labels English without changing send behavior (working=%s)', async working => {
  const props = composer(snapshot({ activity: working ? 'working' : 'idle', currentTurnId: working ? 'turn' : null, controls }));
  let done!: () => void; props.onSend.mockImplementation(() => new Promise<void>(resolve => { done = resolve; }));
  const view = render(<SessionComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
  const label = working ? 'Add to current turn' : 'Send';
  const button = screen.getByRole('button', { name: label }); expect(button).toBeEnabled();
  expect(within(button).getByText(label)).toHaveAttribute('lang', 'en');
  fireEvent.click(button);
  expect(screen.getByRole('button', { name: 'Awaiting provider confirmation' })).toBeDisabled();
  view.setLocale('en'); expect(screen.getByRole('button', { name: 'Awaiting provider confirmation' })).toBeDisabled();
  view.setLocale('zh-CN'); expect(screen.getByRole('button', { name: 'Awaiting provider confirmation' })).toBeDisabled();
  expect(props.onSend).toHaveBeenCalledExactlyOnceWith('hello');
  await act(async () => done());
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('button', { name: label })).toBeDisabled();
});
it('keeps command execution and all interrupt stages English through locale changes', async () => {
  const props = composer();
  let commandDone!: () => void; props.onExecuteCommand.mockImplementation(() => new Promise<void>(resolve => { commandDone = resolve; }));
  const view = render(<SessionComposer {...props} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '/compact' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  for (const locale of ['zh-CN', 'en'] as const) { view.setLocale(locale); expect(screen.getByRole('button', { name: 'Executing command' })).toBeDisabled(); expect(view.container.querySelector('.session-composer-activity [aria-live]')).toHaveTextContent('Executing command'); }
  expect(props.onExecuteCommand).toHaveBeenCalledExactlyOnceWith('compact', '', '3', '/compact');
  await act(async () => commandDone());
  const working = { ...props, state: state(snapshot({ activity: 'working', currentTurnId: 'turn', operations: { canSend: true, canCancel: true, canRespond: true } })) };
  let cancelDone!: () => void; props.onCancel.mockImplementation(() => new Promise<void>(resolve => { cancelDone = resolve; }));
  view.rerender(<SessionComposer {...working} />); view.setLocale('zh-CN');
  expect(screen.getByText('开始时间未知')).toBeVisible();
  const interrupt = screen.getByRole('button', { name: 'Interrupt' }); expect(interrupt).toBeEnabled(); expect(interrupt).toHaveAttribute('lang', 'en');
  fireEvent.click(interrupt); expect(screen.getByRole('button', { name: 'Interrupting…' })).toBeDisabled();
  view.setLocale('en'); expect(screen.getByRole('button', { name: 'Interrupting…' })).toBeDisabled();
  await act(async () => cancelDone());
  for (const locale of ['zh-CN', 'en'] as const) { view.setLocale(locale); expect(screen.getByRole('button', { name: 'Interrupt requested' })).toBeDisabled(); }
  expect(props.onCancel).toHaveBeenCalledOnce();
});
it('keeps tool types English and result statuses localized while answering silently', async () => {
  const entries: TimelineEntry[] = [
    ...(['commandExecution', 'fileChange', '原生工具名'] as const).map((name, index): TimelineEntry => ({ kind: 'tool_call', entryId: String(index), entrySeq: String(index), revision: '1', callId: String(index), name, input: '原始用户内容', output: [], status: (['completed', 'failed', 'running'] as const)[index]!, truncated: false })),
    { kind: 'interaction', entryId: '3', entrySeq: '3', revision: '1', interaction: { kind: 'approval', interactionId: 'approval', revision: '1', state: 'pending', title: '原始审批标题', detail: '原始审批内容', actions: ['allow_once'] } },
  ];
  let done!: () => void; const respond = vi.fn(() => new Promise<void>(resolve => { done = resolve; }));
  const view = render(<SessionTimeline state={{ ...state(snapshot({ operations: { canSend: true, canCancel: true, canRespond: true } })), entries }} active canRespond onRespond={respond} hasOlder={false} loadingOlder={false} onLoadOlder={vi.fn()} onLoadResource={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: '允许一次' }));
  for (const locale of ['zh-CN', 'en', 'zh-CN'] as const) {
    view.setLocale(locale);
    for (const label of ['Command', 'File changes']) expect(screen.getByText(label)).toHaveAttribute('lang', 'en');
    for (const status of locale === 'en' ? ['Completed', 'Failed', 'Running'] : ['已完成', '失败', '运行中']) expect(screen.getByText(status)).toBeVisible();
    expect(screen.getByText('原生工具名')).not.toHaveAttribute('lang');
    expect(screen.queryByText(locale === 'en' ? 'Awaiting provider confirmation' : '等待 Provider 确认')).toBeNull();
    expect(screen.getByText('原始审批标题')).toBeVisible();
    expect(screen.getByText('原始审批内容')).toBeVisible();
    expect(screen.getByRole('button', { name: locale === 'en' ? 'Allow once' : '允许一次' })).toBeDisabled();
    for (const input of screen.getAllByText('原始用户内容')) expect(input).not.toHaveAttribute('lang');
  }
  expect(respond).toHaveBeenCalledOnce();
  await act(async () => done());
});
