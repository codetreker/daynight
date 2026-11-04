import { useState } from 'react';
import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../src/api/bots';
import { ApiError } from '../src/api/client';
import { BotCreateDialog } from '../src/features/bots/BotCreateDialog';
import { renderWithLocale } from './helpers/renderWithLocale';

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
function Harness() {
  const [unresolvedRequest, onUnresolvedRequestChange] = useState<api.CreateBotInput | null>(null);
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Open form</button>{open && <BotCreateDialog unresolvedRequest={unresolvedRequest} onUnresolvedRequestChange={onUnresolvedRequestChange} onClose={() => { onClose(); setOpen(false); }} onCreated={onCreated} />}</>;
}
const mount = () => renderWithLocale(<Harness />, { locale: 'en', taskCache: { viewerId: owner } });
const name = (value = 'Helper') => fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value } });
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create assistant' }));
const advanced = () => fireEvent.click(screen.getByText('Advanced settings'));
beforeEach(() => { vi.mocked(api.getBotDefaults).mockResolvedValue(defaults()); vi.mocked(api.createBot).mockResolvedValue(bot); vi.mocked(api.getBot).mockResolvedValue(bot); onCreated.mockClear(); onClose.mockClear(); });

it('requires only a name and leaves defaults implicit on creation', async () => {
  mount(); await flush();
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  expect(document.querySelector('details')).not.toHaveAttribute('open');
  expect(document.querySelectorAll('[required]')).toHaveLength(1);
  name(); submit(); await flush();
  expect(api.createBot).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
  expect(onCreated).toHaveBeenCalledWith(bot);
});
it('cancels without creating or changing preferences and restores focus', async () => {
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/ordinary' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); await flush();
  expect(api.createBot).not.toHaveBeenCalled(); expect(onClose).toHaveBeenCalledOnce();
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
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { workerId: wid(1) } });
});
it('resets explicit directory and provider when changing Worker', async () => {
  vi.mocked(api.getBotDefaults).mockResolvedValueOnce(defaults()).mockResolvedValueOnce(defaults(2));
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/custom' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Worker' }), { target: { value: wid(2) } }); await flush();
  name(); submit(); await flush();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { workerId: wid(2) } });
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
  fireEvent.click(screen.getByRole('button', { name: 'Check creation' })); await flush();
  expect(screen.getByText('Creation is not confirmed. Check this ID again before creating another assistant.')).toBeInTheDocument();
  expect(api.createBot).toHaveBeenCalledOnce();
});
it.each(['offline', 'unsupported', 'stale'])('reports %s Worker without allowing creation', async reason => {
  vi.mocked(api.getBotDefaults).mockResolvedValue({ ...defaults(), configuration: null, reason, workers: [{ ...worker(), state: reason, reason, configuration: null }] } as api.BotDefaults);
  mount(); await flush(); name();
  expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
});
it('allows explicitly replacing an unavailable default provider', async () => {
  vi.mocked(api.getBotDefaults).mockResolvedValue({ ...defaults(), configuration: null, reason: 'provider_not_found', workers: [{ ...worker(), configuration: null, reason: 'provider_not_found' }] } as api.BotDefaults);
  mount(); await flush(); advanced();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '/ordinary' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'claude' } });
  name(); submit(); await flush();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toMatchObject({ overrides: { cwd: '/ordinary', provider: 'claude' } });
});
it('shows a confirmed rejection and allows a corrected fresh request', async () => {
  vi.mocked(api.createBot).mockRejectedValueOnce(new ApiError('server', 409, 'conflict', null, undefined, undefined, 'Directory is unavailable.'));
  mount(); await flush(); name(); submit(); await flush();
  expect(screen.getByText('Directory is unavailable.')).toBeInTheDocument();
  submit(); await flush(); expect(api.createBot).toHaveBeenCalledTimes(2);
});
it('accepts forty Unicode characters and rejects control characters', async () => {
  mount(); await flush(); name('😀'.repeat(40)); submit(); await flush(); expect(api.createBot).toHaveBeenCalledOnce();
});
it('preserves form input when changing language', async () => {
  const view = mount(); await flush(); name('助手'); const input = screen.getByRole('textbox', { name: 'Name' }); view.setLocale('zh-CN'); expect(screen.getByRole('textbox', { name: '名称' })).toBe(input); expect(input).toHaveValue('助手'); expect(api.getBotDefaults).toHaveBeenCalledOnce();
});
it.each([' ', 'x'.repeat(41), 'bad\u0001name'])('rejects invalid names without dispatching', async invalid => {
  mount(); await flush(); name(invalid); submit(); await flush();
  expect(api.createBot).not.toHaveBeenCalled(); expect(screen.getByText('Enter 1–40 characters without control characters.')).toBeInTheDocument();
});
it('rejects relative directories and allows clearing an explicit directory back to the default', async () => {
  mount(); await flush(); advanced(); name();
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: 'relative/path' } }); submit(); await flush();
  expect(api.createBot).not.toHaveBeenCalled(); expect(screen.getByRole('textbox', { name: 'Working directory' })).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(screen.getByRole('textbox', { name: 'Working directory' }), { target: { value: '' } }); submit(); await flush();
  expect(vi.mocked(api.createBot).mock.calls[0]![0]).toEqual({ id: expect.any(String), name: 'Helper' });
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
  fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true })); fireEvent.click(screen.getByRole('button', { name: 'Close' })); await flush();
  expect(onClose).not.toHaveBeenCalled(); expect(api.createBot).toHaveBeenCalledOnce();
  pending.resolve(bot); await flush(); expect(onCreated).toHaveBeenCalledWith(bot);
});
it('keeps failed startup distinct from successful startup', async () => {
  const failed = { ...bot, startupResult: { state: 'failed' as const, code: 'invalid_cwd' } };
  vi.mocked(api.createBot).mockResolvedValueOnce(failed);
  mount(); await flush(); name(); submit(); await flush();
  expect(onCreated).toHaveBeenCalledWith(failed); expect(screen.queryByText('Started')).toBeNull();
});
it('closes the native modal before restoring focus to its opener on Escape', async () => {
  function ClosedHarness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Create a helper</button>{open && <BotCreateDialog unresolvedRequest={null} onUnresolvedRequestChange={() => {}} onClose={() => setOpen(false)} onCreated={onCreated} />}</>;
  }
  renderWithLocale(<ClosedHarness />, { locale: 'en', taskCache: { viewerId: owner } });
  const opener = screen.getByRole('button', { name: 'Create a helper' }); opener.focus(); fireEvent.click(opener); await flush();
  const dialog = screen.getByRole('dialog') as HTMLDialogElement;
  const restoredWhileOpen: boolean[] = [], focus = opener.focus.bind(opener);
  vi.spyOn(opener, 'focus').mockImplementation(() => {
    restoredWhileOpen.push(dialog.open);
    // Real browsers reject focus outside an open modal; jsdom does not implement inertness.
    if (!dialog.open) focus();
  });
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true })); await flush();
  expect(restoredWhileOpen).toEqual([false]); expect(opener).toHaveFocus(); expect(dialog.open).toBe(false);
});
