import { useState } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../src/api/bots';
import { ApiError } from '../src/api/client';
import { BotCreateDialog } from '../src/features/bots/BotCreateDialog';
import { useTaskCacheScope } from '../src/features/task-cache/TaskCacheProvider';
import { rememberBotCreation } from '../src/features/bots/pending-creation';
import { renderWithLocale } from './helpers/renderWithLocale';
import { assistantCreateSubmit, assistantNameInput, expandAssistantAdvancedSettings, pressAssistantEscape } from './helpers/assistant-ui';

vi.mock('../src/api/bots', async importOriginal => {
  const original = await importOriginal<typeof api>();
  return { ...original, getBotDefaults: vi.fn(), createBot: vi.fn(), getBot: vi.fn() };
});
const owner = '00000009-1111-4111-8111-111111111111';
const wid = (n: number) => `0000000${n}-1111-4111-8111-111111111111`;
const config = (n = 1) => ({ workerId: wid(n), cwd: `/ordinary-${n}`, provider: 'copilot' as const, model: null, args: [] });
const worker = (n = 1) => ({ workerId: wid(n), machine: { id: wid(n + 5), name: `Machine ${n}` }, platform: 'macos' as const, state: 'available', reason: null, configuration: config(n), providers: ['codex', 'claude', 'copilot'].map(provider => ({ provider, available: true, reason: null, model: null, args: [] })) });
const defaults = (n = 1) => ({ observedAt: '2026-11-05T00:00:00Z', workerId: wid(n), configuration: config(n), reason: null, workers: [worker(1), worker(2)] }) as api.BotDefaults;
const bot = { id: wid(3), deletion: null, name: 'Helper', startupResult: { state: 'pending', code: null } } as api.BotDefinition;
const flush = () => act(async () => { for (let n = 0; n < 30; n++) await Promise.resolve(); });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const onCreated = vi.fn(), onClose = vi.fn();
function Harness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const scope = useTaskCacheScope();
  const [unresolvedRequest, setUnresolved] = useState<api.CreateBotInput | null>(null);
  const onUnresolvedRequestChange = (request: api.CreateBotInput | null) => { rememberBotCreation(scope, request); setUnresolved(request); };
  const [open, setOpen] = useState(initiallyOpen);
  return <><button onClick={() => setOpen(true)}>Open form</button>{open && <BotCreateDialog unresolvedRequest={unresolvedRequest} onUnresolvedRequestChange={onUnresolvedRequestChange} onClose={() => { onClose(); setOpen(false); }} onCreated={onCreated} />}</>;
}
const mount = (initiallyOpen = true) => renderWithLocale(<Harness initiallyOpen={initiallyOpen} />, { locale: 'en', taskCache: { viewerId: owner } });
const name = (value = 'Helper') => fireEvent.change(assistantNameInput(), { target: { value } });
const submit = () => fireEvent.click(assistantCreateSubmit());
const advanced = expandAssistantAdvancedSettings;
beforeEach(() => { vi.mocked(api.getBotDefaults).mockResolvedValue(defaults()); vi.mocked(api.createBot).mockResolvedValue(bot); vi.mocked(api.getBot).mockResolvedValue(bot); onCreated.mockClear(); onClose.mockClear(); });

it('requires only a name and leaves defaults implicit on creation', async () => {
  mount(); await flush();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  expect(screen.getByLabelText('Worker')).not.toBeVisible();
  expect(screen.getByLabelText('Working directory')).not.toBeVisible();
  expect(screen.getByLabelText('Agent')).not.toBeVisible();
  expect(document.querySelectorAll('[required]')).toHaveLength(1);
  name(); submit(); await flush();
  expect(api.createBot).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
  expect(onCreated).toHaveBeenCalledWith(bot);
});
it('cancels without creating or changing preferences and restores focus', async () => {
  mount(false);
  const opener = screen.getByRole('button', { name: 'Open form' });
  opener.focus(); fireEvent.click(opener); await flush(); advanced();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/ordinary' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await flush();
  expect(api.createBot).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  expect(opener).toHaveFocus();
});
it('keeps new Worker defaults when the previous response arrives late', async () => {
  const first = deferred<api.BotDefaults>(), second = deferred<api.BotDefaults>();
  vi.mocked(api.getBotDefaults).mockResolvedValueOnce(defaults()).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: wid(2) } }); await flush();
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: wid(1) } }); await flush();
  second.resolve(defaults()); await flush(); first.resolve(defaults(2)); await flush();
  expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue('/ordinary-1');
  name(); submit(); await flush();
  expect(api.getBotDefaults).toHaveBeenNthCalledWith(2, wid(2), expect.any(AbortSignal), expect.objectContaining({ userId: owner }));
  expect(api.getBotDefaults).toHaveBeenNthCalledWith(3, wid(1), expect.any(AbortSignal), expect.objectContaining({ userId: owner }));
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId: wid(1) } });
});
it('resets explicit directory and provider when changing Worker', async () => {
  vi.mocked(api.getBotDefaults).mockResolvedValueOnce(defaults()).mockResolvedValueOnce(defaults(2));
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/custom' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: wid(2) } }); await flush();
  expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue('/ordinary-2');
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('');
  name(); submit(); await flush();
  expect(api.createBot).toHaveBeenCalledOnce();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId: wid(2) } });
});
it('queries an unknown submission by its original ID, including after closing', async () => {
  vi.mocked(api.createBot).mockImplementation(async input => { throw new api.BotCreationUnknown(input.id, new ApiError('network')); });
  mount(); await flush(); name(); submit(); await flush();
  const input = vi.mocked(api.createBot).mock.calls[0]![0];
  expect(screen.getByText(input.id)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Close' })); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Open form' })); await flush();
  expect(screen.queryByRole('button', { name: 'Create assistant' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check creation' })); await flush();
  expect(api.getBot).toHaveBeenCalledWith(input.id, expect.any(AbortSignal), expect.objectContaining({ userId: owner }));
  expect(api.createBot).toHaveBeenCalledOnce(); expect(onCreated).toHaveBeenCalledWith(bot);
});
it('keeps an unknown request after a 404 and permits another read only', async () => {
  vi.mocked(api.createBot).mockImplementation(async input => { throw new api.BotCreationUnknown(input.id, new ApiError('network')); });
  vi.mocked(api.getBot).mockRejectedValue(new ApiError('server', 404, 'not_found'));
  mount(); await flush(); name(); submit(); await flush();
  const originalId = vi.mocked(api.createBot).mock.calls[0]![0].id;
  fireEvent.click(screen.getByRole('button', { name: 'Check creation' })); await flush();
  expect(screen.getByText('Creation is not confirmed. Check this ID again before creating another assistant.')).toBeInTheDocument();
  expect(screen.getByText(originalId)).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check creation' })); await flush();
  expect(api.getBot).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(api.getBot).mock.calls) expect(call).toEqual([originalId, expect.any(AbortSignal), expect.objectContaining({ userId: owner })]);
  expect(api.createBot).toHaveBeenCalledOnce();
  expect(onCreated).not.toHaveBeenCalled();
});
it.each(['offline', 'unsupported', 'stale'])('reports %s Worker without allowing creation', async reason => {
  vi.mocked(api.getBotDefaults).mockResolvedValue({ ...defaults(), configuration: null, reason, workers: [{ ...worker(), state: reason, reason, configuration: null }] } as api.BotDefaults);
  mount(); await flush(); name();
  expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
});
it('allows explicitly replacing an unavailable default provider', async () => {
  vi.mocked(api.getBotDefaults).mockImplementation(async (_workerId, _signal, _admission, choices) => choices?.provider
    ? { ...defaults(), configuration: { ...config(), cwd: choices.cwd ?? '/ordinary', provider: choices.provider } }
    : { ...defaults(), configuration: null, reason: 'provider_not_found', workers: [{ ...worker(), configuration: null, reason: 'provider_not_found' }] } as api.BotDefaults);
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/ordinary' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  await flush(); name(); submit(); await flush();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { workerId: wid(1), cwd: '/ordinary', provider: 'claude' } });
});
it('shows a confirmed rejection and allows a corrected fresh request', async () => {
  vi.mocked(api.createBot).mockRejectedValueOnce(new ApiError('server', 409, 'conflict', null, undefined, 'Directory is unavailable.'));
  mount(); await flush(); advanced(); name();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/unavailable' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  await flush(); submit(); await flush();
  expect(screen.getByText('Directory is unavailable.')).toBeInTheDocument();
  expect(assistantNameInput()).toHaveValue('Helper');
  expect(screen.getByLabelText('Working directory')).toHaveValue('/unavailable');
  expect(screen.getByLabelText('Agent')).toHaveValue('claude');
  expect(onCreated).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Check creation' })).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/corrected' } });
  await flush(); submit(); await flush();
  expect(api.createBot).toHaveBeenCalledTimes(2);
  const [first, second] = vi.mocked(api.createBot).mock.calls.map(call => call[0]);
  expect(first).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId: wid(1), cwd: '/unavailable', provider: 'claude' } });
  expect(second).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId: wid(1), cwd: '/corrected', provider: 'claude' } });
  expect(second!.id).not.toBe(first!.id);
  expect(api.getBot).not.toHaveBeenCalled();
  expect(onCreated).toHaveBeenCalledWith(bot);
});
it('trims Unicode whitespace and counts astral characters as one character', async () => {
  mount(); await flush(); name(`\u3000${'😀'.repeat(40)}\u2003`); submit(); await flush();
  expect(api.createBot).toHaveBeenCalledOnce();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: '😀'.repeat(40) });
});
it('preserves form input when changing language', async () => {
  const view = mount(); await flush(); name('助手'); const input = screen.getByRole('textbox', { name: 'Name' }); view.setLocale('zh-CN'); expect(screen.getByRole('textbox', { name: '名称' })).toBe(input); expect(input).toHaveValue('助手'); expect(api.getBotDefaults).toHaveBeenCalledOnce();
});
it.each([' ', 'x'.repeat(41), '😀'.repeat(41), 'bad\u0001name', 'bad\ud800name'])('rejects invalid names without dispatching', async invalid => {
  mount(); await flush(); name(invalid); submit(); await flush();
  expect(api.createBot).not.toHaveBeenCalled(); expect(screen.getByText('Enter 1–40 characters without control characters.')).toBeInTheDocument();
});
it('rejects relative directories and allows clearing an explicit directory back to the default', async () => {
  mount(); await flush(); advanced(); name();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: 'relative/path' } }); submit(); await flush();
  expect(api.createBot).not.toHaveBeenCalled(); expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '' } }); await flush(); submit(); await flush();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper', overrides: { workerId: wid(1) } });
});
it('retries failed defaults without losing the name', async () => {
  vi.mocked(api.getBotDefaults).mockRejectedValueOnce(new ApiError('network')).mockResolvedValueOnce(defaults());
  mount(); await flush(); name(); expect(screen.getByText('Could not load creation defaults.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await flush();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Helper'); submit(); await flush(); expect(onCreated).toHaveBeenCalledWith(bot);
});
it('cannot dismiss or resubmit while a request is in flight', async () => {
  const pending = deferred<api.BotDefinition>(); vi.mocked(api.createBot).mockReturnValueOnce(pending.promise);
  mount(); await flush(); name(); submit(); await flush();
  pressAssistantEscape(); fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Creating…' })); await flush();
  expect(onClose).not.toHaveBeenCalled(); expect(api.createBot).toHaveBeenCalledOnce();
  pending.resolve(bot); await flush(); expect(onCreated).toHaveBeenCalledWith(bot);
});
it('keeps failed startup distinct from successful startup', async () => {
  const failed = { ...bot, startupResult: { state: 'failed' as const, code: 'invalid_cwd' } };
  vi.mocked(api.createBot).mockResolvedValueOnce(failed);
  mount(); await flush(); name(); submit(); await flush();
  expect(onCreated).toHaveBeenCalledWith(failed); expect(screen.queryByText('Started')).toBeNull();
});
it('dismisses creation on Escape and returns focus to its opener', async () => {
  function ClosedHarness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Create a helper</button>{open && <BotCreateDialog unresolvedRequest={null} onUnresolvedRequestChange={() => {}} onClose={() => setOpen(false)} onCreated={onCreated} />}</>;
  }
  renderWithLocale(<ClosedHarness />, { locale: 'en', taskCache: { viewerId: owner } });
  const opener = screen.getByRole('button', { name: 'Create a helper' }); opener.focus(); fireEvent.click(opener); await flush();
  expect(assistantNameInput()).toHaveFocus();
  const modal = document.querySelector('dialog[open]'), focus = opener.focus.bind(opener);
  vi.spyOn(opener, 'focus').mockImplementation(() => {
    // Model native modality only when present: a still-open modal prevents
    // returning focus outside it, while an inline form imposes no such limit.
    if (!(modal instanceof HTMLDialogElement) || !modal.open) focus();
  });
  pressAssistantEscape(); await flush();
  expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  expect(opener).toHaveFocus(); expect(document.body.style.overflow).not.toBe('hidden');
  expect(onCreated).not.toHaveBeenCalled();
});

it('does not submit until the initial defaults have arrived', async () => {
  const pending = deferred<api.BotDefaults>();
  vi.mocked(api.getBotDefaults).mockReturnValueOnce(pending.promise);
  mount(); await flush(); name();
  expect(assistantCreateSubmit()).toBeDisabled();
  fireEvent.submit((assistantNameInput() as HTMLInputElement).form!); await flush();
  expect(api.createBot).not.toHaveBeenCalled();
  pending.resolve(defaults()); await flush();
  expect(assistantNameInput()).toHaveValue('Helper');
  expect(assistantCreateSubmit()).toBeEnabled();
  submit(); await flush();
  expect(api.createBot).toHaveBeenCalledOnce();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});

it('returns to implicit defaults when switching an explicit Worker back to automatic', async () => {
  vi.mocked(api.getBotDefaults).mockResolvedValueOnce(defaults()).mockResolvedValueOnce(defaults(2)).mockResolvedValueOnce(defaults());
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: wid(2) } }); await flush();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/custom-2' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: '' } }); await flush();
  expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveValue('/ordinary-1');
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('');
  expect(api.getBotDefaults).toHaveBeenLastCalledWith(null, expect.any(AbortSignal), expect.objectContaining({ userId: owner }));
  name(); submit(); await flush();
  expect(api.createBot).toHaveBeenCalledOnce();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
});

it('retains explicit advanced settings across locale changes and collapse', async () => {
  const view = mount(); await flush(); advanced(); name('助手');
  const input = assistantNameInput();
  const directory = screen.getByRole('textbox', { name: 'Working directory' });
  fireEvent.change(directory, { target: { value: '/projects/中文' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'codex' } });
  view.setLocale('zh-CN');
  expect(screen.getByRole('textbox', { name: '名称' })).toBe(input);
  expect(screen.getByRole('textbox', { name: '工作目录' })).toBe(directory);
  expect(directory).toHaveValue('/projects/中文');
  expect(screen.getByRole('combobox', { name: 'Agent' })).toHaveValue('codex');
  fireEvent.click(screen.getByText('高级设置'));
  expect(directory).not.toBeVisible();
  await flush(); submit(); await flush();
  expect(api.getBotDefaults).toHaveBeenCalledWith(wid(1), expect.any(AbortSignal), expect.objectContaining({ userId: owner }), { cwd: '/projects/中文', provider: 'codex' });
  expect(api.createBot).toHaveBeenCalledOnce();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: '助手', overrides: { workerId: wid(1), cwd: '/projects/中文', provider: 'codex' } });
});

it('keeps composition Escape inside the form without cancelling the draft', async () => {
  mount(); await flush(); name('尚未完成');
  const input = assistantNameInput();
  fireEvent.keyDown(input, { key: 'Escape', code: 'Escape', isComposing: true }); await flush();
  expect(onClose).not.toHaveBeenCalled();
  expect(assistantNameInput()).toBe(input);
  expect(input).toHaveValue('尚未完成');
  expect(input).toHaveFocus();
  expect(api.createBot).not.toHaveBeenCalled();
  pressAssistantEscape(input); await flush();
  expect(onClose).toHaveBeenCalledOnce();
});

it('leaves popup Escape to the native control while stopping the outer handler', async () => {
  mount(); await flush(); advanced(); name('Kept draft');
  const select = screen.getByRole('combobox', { name: 'Worker' });
  const originalMatches = select.matches.bind(select);
  const matches = vi.spyOn(select, 'matches').mockImplementation(query => query === ':open' || originalMatches(query));
  const outer = vi.fn(); document.addEventListener('keydown', outer);
  try {
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fireEvent(select, escape); await flush();
    expect(escape.defaultPrevented).toBe(false);
    expect(outer).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(assistantNameInput()).toHaveValue('Kept draft');
    expect(api.createBot).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('keydown', outer);
    matches.mockRestore();
  }
});

it('ignores an Escape reported as IME key code 229', async () => {
  mount(); await flush(); name('Composition draft');
  fireEvent.keyDown(assistantNameInput(), { key: 'Escape', keyCode: 229 }); await flush();
  expect(onClose).not.toHaveBeenCalled();
  expect(assistantNameInput()).toHaveValue('Composition draft');
});

it('settles a confirmed creation during a pause and protects later edits on resume', async () => {
  const pending = deferred<api.BotDefinition>();
  vi.mocked(api.createBot).mockImplementationOnce((_input, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); });
  pending.resolve(bot); await flush();
  expect(screen.getByText('Assistant creation confirmed.')).toBeInTheDocument();
  expect(assistantNameInput()).toHaveValue('Helper');
  expect(assistantNameInput()).toBeEnabled();
  expect(onCreated).not.toHaveBeenCalled();
  name('New draft');
  act(() => resume()); await flush();
  expect(assistantNameInput()).toHaveValue('New draft');
  expect(onCreated).not.toHaveBeenCalled();
  expect(api.createBot).toHaveBeenCalledOnce(); expect(api.getBot).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }));
  expect(onCreated).toHaveBeenCalledWith(bot);
});

it('retains the original ID when a dispatched creation is cancelled without a receipt', async () => {
  let reject!: (cause: unknown) => void;
  vi.mocked(api.createBot).mockImplementationOnce((_input, _signal, admission) => new Promise((_resolve, fail) => {
    admission.onDispatch?.(); reject = fail;
  }));
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  const input = vi.mocked(api.createBot).mock.calls[0]![0];
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); });
  reject(new api.BotCreationUnknown(input.id, new DOMException('Aborted', 'AbortError'))); await flush();
  expect(screen.getByText(input.id)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  expect(api.createBot).toHaveBeenCalledOnce(); expect(api.getBot).not.toHaveBeenCalled();
  act(() => resume()); await flush();
  expect(api.createBot).toHaveBeenCalledOnce(); expect(api.getBot).not.toHaveBeenCalled();
});

it('cancels a creation waiting before dispatch without retaining a false unknown', async () => {
  vi.mocked(api.createBot).mockImplementationOnce((_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); }); await flush();
  expect(assistantNameInput()).toHaveValue('Helper');
  expect(assistantNameInput()).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Check creation' })).toBeNull();
  act(() => resume()); await flush();
  expect(api.createBot).toHaveBeenCalledOnce(); expect(api.getBot).not.toHaveBeenCalled();
});

it('retains a trusted check result when pause cancels its owner at the receipt boundary', async () => {
  vi.mocked(api.createBot).mockImplementationOnce(async input => { throw new api.BotCreationUnknown(input.id, new ApiError('network')); });
  const pending = deferred<api.BotDefinition>(); vi.mocked(api.getBot).mockReturnValueOnce(pending.promise);
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Check creation' })); await flush();
  let resume!: () => void;
  act(() => { pending.resolve(bot); resume = pauseAuthRequests(); }); await flush();
  expect(screen.getByText('Assistant creation confirmed.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check creation' })).toBeNull();
  expect(onCreated).not.toHaveBeenCalled();
  act(() => resume()); await flush();
  expect(api.getBot).toHaveBeenCalledOnce(); expect(onCreated).not.toHaveBeenCalled();
});

it('does not navigate or read automatically when an unchanged confirmed draft resumes', async () => {
  const pending = deferred<api.BotDefinition>();
  vi.mocked(api.createBot).mockImplementationOnce((_input, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); });
  pending.resolve(bot); await flush();
  act(() => resume()); await flush();
  expect(onCreated).not.toHaveBeenCalled(); expect(api.getBot).not.toHaveBeenCalled();
  expect(screen.getByText('Assistant creation confirmed.')).toBeInTheDocument();
});

it('does not navigate when a dispatched response arrives after a temporary pause has ended', async () => {
  const pending = deferred<api.BotDefinition>();
  vi.mocked(api.createBot).mockImplementationOnce((_input, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); resume(); });
  pending.resolve(bot); await flush();
  expect(screen.getByText('Assistant creation confirmed.')).toBeInTheDocument();
  expect(onCreated).not.toHaveBeenCalled(); expect(api.getBot).not.toHaveBeenCalled();
});

it('reconciles a confirmed identity after its publishing form closes during pause', async () => {
  const pending = deferred<api.BotDefinition>();
  vi.mocked(api.createBot).mockImplementationOnce((_input, _signal, admission) => { admission.onDispatch?.(); return pending.promise; });
  const { pauseAuthRequests } = await import('../src/api/client');
  mount(); await flush(); name(); submit(); await flush();
  let resume!: () => void;
  act(() => { resume = pauseAuthRequests(); });
  pending.resolve(bot); await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Close creation form' })); await flush();
  act(() => resume());
  fireEvent.click(screen.getByRole('button', { name: 'Open form' })); await flush();
  expect(screen.getByText('Assistant creation confirmed.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Check creation' })).toBeNull();
  name('New draft'); await flush();
  expect(assistantCreateSubmit()).toBeEnabled();
  expect(onCreated).not.toHaveBeenCalled(); expect(api.getBot).not.toHaveBeenCalled();
});

it('retries confirmed identity admission when another pause starts at the ready boundary', async () => {
  const { pauseAuthRequests } = await import('../src/api/client');
  const { rememberConfirmedBotCreation } = await import('../src/features/bots/pending-creation');
  const request = { id: wid(3), name: 'Helper' };
  let resume!: () => void;
  function RaceHarness() {
    const scope = useTaskCacheScope();
    const [unresolved, setUnresolved] = useState<api.CreateBotInput | null>(() => {
      rememberBotCreation(scope, request); rememberConfirmedBotCreation(scope, request, bot);
      vi.spyOn(scope, 'ready').mockImplementationOnce(async () => { resume = pauseAuthRequests(); });
      return request;
    });
    return <BotCreateDialog unresolvedRequest={unresolved} onUnresolvedRequestChange={value => { rememberBotCreation(scope, value); setUnresolved(value); }} onClose={onClose} onCreated={onCreated} />;
  }
  renderWithLocale(<RaceHarness />, { locale: 'en', taskCache: { viewerId: owner } });
  await flush();
  expect(assistantCreateSubmit()).toBeDisabled();
  act(() => resume()); await flush();
  expect(assistantCreateSubmit()).toBeEnabled();
  expect(api.getBot).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled();
});

it('ends confirmed creation admission after a retained scope observes a different principal', async () => {
  const { getTask, pauseAuthRequests } = await import('../src/api/client');
  const { createTaskCacheScope } = await import('../src/features/task-cache/project-cache');
  const { pendingBotCreation, rememberConfirmedBotCreation } = await import('../src/features/bots/pending-creation');
  let resume = () => {};
  const scope = createTaskCacheScope({ userId: owner, onIdentityMismatch: () => { resume = pauseAuthRequests(); } });
  const request = { id: wid(3), name: 'Helper' };
  rememberBotCreation(scope, request); rememberConfirmedBotCreation(scope, request, bot);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Daynight-User-ID': wid(2) } })));
  await expect(getTask(wid(4), wid(5), new AbortController().signal, { userId: owner, onPrincipalMismatch: scope.principalMismatch })).rejects.toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
  const ready = scope.ready.bind(scope); let attempts = 0, exceeded = false;
  vi.spyOn(scope, 'ready').mockImplementation(async signal => {
    if (++attempts > 10) { exceeded = true; resume(); throw new Error('Identity admission retried indefinitely'); }
    return ready(signal);
  });
  const unresolvedChanged = vi.fn();
  const view = renderWithLocale(<BotCreateDialog unresolvedRequest={request} onUnresolvedRequestChange={unresolvedChanged} onClose={onClose} onCreated={onCreated} />, { locale: 'en', taskCache: { scope } });
  try {
    await flush();
    expect(attempts).toBeGreaterThan(0); expect(exceeded).toBe(false);
    expect(scope.hasIdentityMismatch).toBe(true); expect(scope.signal.aborted).toBe(false); expect(scope.isInvalidated).toBe(false);
    expect(pendingBotCreation(scope)).toEqual(request); expect(unresolvedChanged).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled(); expect(api.getBot).not.toHaveBeenCalled();
  } finally { view.unmount(); resume(); scope.dispose(); }
});

it('retains a confirmed creation when identity changes between readiness and publication', async () => {
  const { getTask } = await import('../src/api/client');
  const { createTaskCacheScope } = await import('../src/features/task-cache/project-cache');
  const { confirmedBotCreations, pendingBotCreation, rememberConfirmedBotCreation } = await import('../src/features/bots/pending-creation');
  const mismatch = vi.fn();
  const scope = createTaskCacheScope({ userId: owner, onIdentityMismatch: mismatch });
  const request = { id: wid(3), name: 'Helper' };
  rememberBotCreation(scope, request); rememberConfirmedBotCreation(scope, request, bot);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'Daynight-User-ID': wid(2) } })));
  const ready = scope.ready.bind(scope); let triggered = false, failure: unknown;
  vi.spyOn(scope, 'ready').mockImplementation(async signal => {
    await ready(signal);
    if (!triggered) {
      triggered = true;
      try { await getTask(wid(4), wid(5), new AbortController().signal, { userId: owner, onPrincipalMismatch: scope.principalMismatch }); }
      catch (error) { failure = error; }
    }
  });
  const unresolvedChanged = vi.fn();
  const view = renderWithLocale(<BotCreateDialog unresolvedRequest={request} onUnresolvedRequestChange={unresolvedChanged} onClose={onClose} onCreated={onCreated} />, { locale: 'en', taskCache: { scope } });
  try {
    await flush();
    expect(mismatch).toHaveBeenCalledOnce();
    expect(failure).toMatchObject({ kind: 'protocol', code: 'principal_mismatch' });
    expect(scope.signal.aborted).toBe(false); expect(scope.isInvalidated).toBe(false);
    expect(pendingBotCreation(scope)).toEqual(request); expect(confirmedBotCreations(scope)).toEqual([{ request, bot }]);
    expect(unresolvedChanged).not.toHaveBeenCalled(); expect(onCreated).not.toHaveBeenCalled();
  } finally { view.unmount(); scope.dispose(); }
});
